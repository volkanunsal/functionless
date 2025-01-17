import * as path from "path";
import * as appsync from "@aws-cdk/aws-appsync-alpha";
import {
  App,
  aws_dynamodb,
  RemovalPolicy,
  Stack,
  aws_events,
  Duration,
} from "aws-cdk-lib";
import {
  $AWS,
  $SFN,
  $util,
  AppsyncResolver,
  Function,
  StepFunction,
  Table,
  EventBus,
  Event,
  ExpressStepFunction,
} from "functionless";

export const app = new App();
export const stack = new Stack(app, "message-board");

const database = new Table<Post | Comment, "pk", "sk">(
  new aws_dynamodb.Table(stack, "MessageBoard", {
    tableName: "MessageBoard",
    partitionKey: {
      name: "pk",
      type: aws_dynamodb.AttributeType.STRING,
    },
    sortKey: {
      name: "sk",
      type: aws_dynamodb.AttributeType.STRING,
    },
    billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.DESTROY,
  })
);

const schema = new appsync.Schema({
  filePath: path.join(__dirname, "..", "message-board.gql"),
});

const api = new appsync.GraphqlApi(stack, "Api", {
  name: "MessageBoard",
  schema,
  authorizationConfig: {
    defaultAuthorization: {
      authorizationType: appsync.AuthorizationType.IAM,
    },
  },
  xrayEnabled: true,
  logConfig: {
    fieldLogLevel: appsync.FieldLogLevel.ALL,
    excludeVerboseContent: false,
  },
});

const getPostResolver = new AppsyncResolver<
  { postId: string },
  Post | undefined
>(($context) => {
  return database.getItem({
    key: {
      pk: {
        S: `Post|${$context.arguments.postId}`,
      },
      sk: {
        S: "Post",
      },
    },
  });
});

export const getPost = getPostResolver.addResolver(api, {
  typeName: "Query",
  fieldName: "getPost",
});

const commentResolver = new AppsyncResolver<
  { nextToken?: string; limit?: number },
  CommentPage,
  Omit<Post, "comments">
>(($context) => {
  const response = database.query({
    query: {
      expression: `pk = :pk and begins_with(#sk,:sk)`,
      expressionValues: {
        ":pk": {
          S: $context.source.pk,
        },
        ":sk": {
          S: "Comment|",
        },
      },
      expressionNames: {
        "#sk": "sk",
      },
    },
    nextToken: $context.arguments.nextToken,
    limit: $context.arguments.limit,
  });

  if (response.items !== undefined) {
    return {
      comments: response.items as Comment[],
      nextToken: response.nextToken,
    };
  }
  return {
    comments: [],
  };
});

export const comments = commentResolver.addResolver(api, {
  typeName: "Post",
  fieldName: "comments",
});

export const createPost = new AppsyncResolver<{ title: string }, Post>(
  ($context) => {
    const postId = $util.autoUlid();
    const post = database.putItem({
      key: {
        pk: {
          S: `Post|${postId}`,
        },
        sk: {
          S: "Post",
        },
      },
      attributeValues: {
        postId: {
          S: postId,
        },
        title: {
          S: $context.arguments.title,
        },
      },
    });

    return post;
  }
).addResolver(api, {
  typeName: "Mutation",
  fieldName: "createPost",
});

export const validateComment = new Function<
  { commentText: string },
  "ok" | "bad"
>(stack, "ValidateComment", async () => {
  return "ok" as const;
});

export const commentValidationWorkflow = new StepFunction<
  { postId: string; commentId: string; commentText: string },
  void
>(stack, "CommentValidationWorkflow", (input) => {
  const status = validateComment({ commentText: input.commentText });
  if (status === "bad") {
    $AWS.DynamoDB.DeleteItem({
      TableName: database,
      Key: {
        pk: {
          S: `Post|${input.postId}`,
        },
        sk: {
          S: `Comment|${input.commentId}`,
        },
      },
    });
  }
});

export const addComment = new AppsyncResolver<
  { postId: string; commentText: string },
  Comment
>(($context) => {
  const commentId = $util.autoUlid();
  const comment = database.putItem({
    key: {
      pk: {
        S: `Post|${$context.arguments.postId}`,
      },
      sk: {
        S: `Comment|${commentId}`,
      },
    },
    attributeValues: {
      postId: {
        S: $context.arguments.postId,
      },
      commentId: {
        S: commentId,
      },
      commentText: {
        S: $context.arguments.commentText,
      },
      createdTime: {
        S: $util.time.nowISO8601(),
      },
    },
  });

  // kick off a workflow to validate the comment
  commentValidationWorkflow({ input: comment });

  return comment;
}).addResolver(api, {
  typeName: "Mutation",
  fieldName: "addComment",
});

interface MessageDeletedEvent
  extends Event<
    { count: number },
    "Delete-Message-Success",
    "MessageDeleter"
  > {}

interface PostDeletedEvent
  extends Event<{ id: string }, "Delete-Post-Success", "MessageDeleter"> {}

const customDeleteBus = new EventBus<MessageDeletedEvent | PostDeletedEvent>(
  stack,
  "deleteBus"
);

const deleteWorkflow = new StepFunction<{ postId: string }, void>(
  stack,
  "DeletePostWorkflow",
  (input) => {
    while (true) {
      try {
        const comments = $AWS.DynamoDB.Query({
          TableName: database,
          KeyConditionExpression: `pk = :pk`,
          ExpressionAttributeValues: {
            ":pk": {
              S: `Post|${input.postId}`,
            },
          },
        });

        if (comments.Items?.[0] !== undefined) {
          $SFN.forEach(comments.Items, (comment) =>
            $AWS.DynamoDB.DeleteItem({
              TableName: database,
              Key: {
                pk: comment.pk,
                sk: comment.sk,
              },
            })
          );

          customDeleteBus.putEvents({
            "detail-type": "Delete-Message-Success",
            source: "MessageDeleter",
            detail: {
              count: comments.Items.length,
            },
          });
        } else {
          $AWS.DynamoDB.DeleteItem({
            TableName: database,
            Key: {
              pk: {
                S: `Post|${input.postId}`,
              },
              sk: {
                S: "Post",
              },
            },
          });

          customDeleteBus.putEvents({
            "detail-type": "Delete-Post-Success",
            source: "MessageDeleter",
            detail: {
              id: input.postId,
            },
          });

          return {
            status: "deleted",
            postId: input.postId,
          };
        }
      } catch {
        $SFN.waitFor(10);
      }
    }
  }
);

export const deletePost = new AppsyncResolver<
  { postId: string },
  AWS.StepFunctions.StartExecutionOutput | undefined
>(($context) => {
  const item = database.getItem({
    key: {
      pk: {
        S: `Post|${$context.arguments.postId}`,
      },
      sk: {
        S: "Post",
      },
    },
  });

  if (item === undefined) {
    return undefined;
  }

  return deleteWorkflow({ input: { postId: $context.arguments.postId } });
}).addResolver(api, {
  typeName: "Mutation",
  fieldName: "deletePost",
});

export const getDeletionStatus = new AppsyncResolver<
  { executionArn: string },
  string | undefined
>(($context) => {
  const executionStatus = deleteWorkflow.describeExecution(
    $context.arguments.executionArn
  );

  return executionStatus.status;
}).addResolver(api, {
  typeName: "Query",
  fieldName: "getDeletionStatus",
});

export interface CommentPage {
  nextToken?: string;
  comments: Comment[];
}

interface Notification {
  message: string;
}

interface TestDeleteEvent extends Event<{ postId: string }, "Delete", "test"> {}

const sendNotification = new Function<Notification, void>(
  stack,
  "sendNotification",
  async (event) => {
    console.log("notification: ", event);
  }
);

const defaultBus = EventBus.default<TestDeleteEvent>(stack);

deleteWorkflow
  .onSucceeded(stack, "deleteSuccessfulEvent")
  .map((event) => ({
    message: `post deleted ${event.id} using ${deleteWorkflow.stateMachineName}`,
  }))
  .pipe(sendNotification);

defaultBus
  .when(stack, "testDelete", (event) => event.source === "test")
  .map((event) => event.detail)
  .pipe(deleteWorkflow);

customDeleteBus
  .when(
    stack,
    "Delete Message Rule",
    (event) => event["detail-type"] === "Delete-Message-Success"
  )
  .map(
    (event) =>
      <Notification>{
        message: `Messages deleted: ${
          (<MessageDeletedEvent>event).detail.count
        }`,
      }
  )
  .pipe(sendNotification);

customDeleteBus
  .when(
    stack,
    "Delete Post Rule",
    (event) => event["detail-type"] === "Delete-Post-Success"
  )
  .map(
    (event) =>
      <Notification>{
        message: `Post Deleted: ${(<PostDeletedEvent>event).detail.id}`,
      }
  )
  .pipe(sendNotification);

/**
 * Native Function test
 */

new aws_events.EventBus(stack, "busbus");

const b = { bus: customDeleteBus };

const func = new Function<undefined, string>(stack, "testFunc2", async () => {
  return "hi";
});

const exprSfn = new ExpressStepFunction(stack, "exp", () => {
  return "woo";
});

new Function(
  stack,
  "testFunc",
  {
    timeout: Duration.minutes(1),
  },
  async () => {
    const result = func();
    console.log(`function result: ${result}`);
    customDeleteBus.putEvents({
      "detail-type": "Delete-Post-Success",
      source: "MessageDeleter",
      detail: {
        id: "from the test method!!",
      },
    });
    const result2 = $AWS.EventBridge.putEvents({
      Entries: [
        {
          EventBusName: customDeleteBus.eventBusArn,
          Source: "MessageDeleter",
          Detail: JSON.stringify({
            id: "from the sdk put event method!",
          }),
          DetailType: "Delete-Post-Success",
        },
      ],
    });
    console.log(`bus: ${JSON.stringify(result2)}`);
    const exc = deleteWorkflow({
      input: {
        postId: "something",
      },
    });
    const { bus } = b;
    bus.putEvents({
      "detail-type": "Delete-Message-Success",
      detail: { count: 0 },
      source: "MessageDeleter",
    });
    console.log(deleteWorkflow.describeExecution(exc.executionArn));
    $AWS.DynamoDB.PutItem({
      TableName: database,
      Item: {
        pk: { S: "Post|1" },
        sk: { S: "Post" },
        postId: {
          S: "1",
        },
        title: { S: "myPost" },
      },
    });
    const item = $AWS.DynamoDB.GetItem({
      TableName: database,
      ConsistentRead: true,
      Key: { pk: { S: "Post|1" }, sk: { S: "Post" } },
    });
    console.log(item.Item?.pk?.S);
    return exprSfn({});
    // return "hi";
  }
);

/**
 * GraphQL created with Code-First
 */
const api2 = new appsync.GraphqlApi(stack, "Api2", {
  name: "MessageReader",
});

/*
  type Query {
    getPost(postId: string!): Post
  }

 type Post {
  postId: ID!
  title: String!
  comments(nextToken: String, limit: Int): CommentPage
 }

 type CommentPage {
  nextToken: String
  comments: [Comment]!
 }

 type Comment {
  postId: ID!
  commentId: ID!
  commentText: String!
  createdTime: String!
 }
 */

const post = api2.addType(
  new appsync.ObjectType("Post", {
    definition: {
      postId: appsync.GraphqlType.id({
        isRequired: true,
      }),
      title: appsync.GraphqlType.string({
        isRequired: true,
      }),
    },
  })
);

const comment = api2.addType(
  new appsync.ObjectType("Comment", {
    definition: {
      postId: appsync.GraphqlType.id({
        isRequired: true,
      }),
      commentId: appsync.GraphqlType.id({
        isRequired: true,
      }),
      commentText: appsync.GraphqlType.string({
        isRequired: true,
      }),
      createdTime: appsync.GraphqlType.string({
        isRequired: true,
      }),
    },
  })
);

const commentPage = api2.addType(
  new appsync.ObjectType("CommentPage", {
    definition: {
      nextToken: appsync.GraphqlType.string(),
      comments: appsync.GraphqlType.intermediate({
        intermediateType: comment,
        isRequiredList: true,
      }),
    },
  })
);

post.addField({
  fieldName: "comments",
  field: commentResolver.getField(api2, commentPage.attribute(), {
    args: {
      nextToken: appsync.GraphqlType.string(),
      limit: appsync.GraphqlType.int(),
    },
  }),
});

api2.addQuery(
  "getPost",
  getPostResolver.getField(api2, post.attribute(), {
    args: {
      postId: appsync.GraphqlType.string({ isRequired: true }),
    },
  })
);

export interface Post<PostID extends string = string> {
  pk: `Post|${PostID}`;
  sk: "Post";
  postId: PostID;
  title: string;
}

export interface Comment<
  PostID extends string = string,
  CommentID extends string = string
> {
  pk: `Post|${PostID}`;
  sk: `Comment|${CommentID}`;
  postId: PostID;
  commentId: CommentID;
  commentText: string;
  createdTime: string;
}
