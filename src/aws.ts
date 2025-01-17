import type { DynamoDB as AWSDynamoDB, EventBridge } from "aws-sdk";
import { JsonFormat } from "typesafe-dynamodb";
import { TypeSafeDynamoDBv2 } from "typesafe-dynamodb/lib/client-v2";
import {
  DeleteItemInput,
  DeleteItemOutput,
} from "typesafe-dynamodb/lib/delete-item";
import { GetItemInput, GetItemOutput } from "typesafe-dynamodb/lib/get-item";
import { TableKey } from "typesafe-dynamodb/lib/key";
import { PutItemInput, PutItemOutput } from "typesafe-dynamodb/lib/put-item";
import { QueryInput, QueryOutput } from "typesafe-dynamodb/lib/query";
import { ScanInput, ScanOutput } from "typesafe-dynamodb/lib/scan";
import {
  UpdateItemInput,
  UpdateItemOutput,
} from "typesafe-dynamodb/lib/update-item";
import { ASL } from "./asl";
import {
  Expr,
  isObjectLiteralExpr,
  isPropAssignExpr,
  isReferenceExpr,
  isVariableReference,
  ObjectLiteralExpr,
} from "./expression";
import {
  Function,
  isFunction,
  NativeIntegration,
  NativePreWarmContext,
  PrewarmClients,
} from "./function";
import { IntegrationInput, makeIntegration } from "./integration";
import { Table, isTable, AnyTable } from "./table";

import type { AnyFunction } from "./util";

type Item<T extends Table<any, any, any>> = T extends Table<infer I, any, any>
  ? I
  : never;

type PartitionKey<T extends Table<any, any, any>> = T extends Table<
  any,
  infer PK,
  any
>
  ? PK
  : never;

type RangeKey<T extends Table<any, any, any>> = T extends Table<
  any,
  any,
  infer SK
>
  ? SK
  : never;

export function isAWS(a: any): a is typeof $AWS {
  return a?.kind === "AWS";
}

/**
 * The `AWS` namespace exports functions that map to AWS Step Functions AWS-SDK Integrations.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/supported-services-awssdk.html
 */
export namespace $AWS {
  export const kind = "AWS";

  /**
   * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ddb.html
   */
  export namespace DynamoDB {
    /**
     * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ddb.html
     */
    export const DeleteItem = makeDynamoIntegration<
      "deleteItem",
      <
        T extends Table<any, any, any>,
        Key extends TableKey<
          Item<T>,
          PartitionKey<T>,
          RangeKey<T>,
          JsonFormat.AttributeValue
        >,
        ConditionExpression extends string | undefined,
        ReturnValue extends AWSDynamoDB.ReturnValue = "NONE"
      >(
        input: { TableName: T } & Omit<
          DeleteItemInput<
            Item<T>,
            PartitionKey<T>,
            RangeKey<T>,
            Key,
            ConditionExpression,
            ReturnValue,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => DeleteItemOutput<Item<T>, ReturnValue, JsonFormat.AttributeValue>
    >("deleteItem", {
      native: {
        bind: (context, table) => {
          table.resource.grantWriteData(context.resource);
        },
        call: async (args, preWarmContext) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, ...rest } = input;

          return dynamo
            .deleteItem({
              ...rest,
              TableName: input.TableName.resource.tableName,
            })
            .promise();
        },
      },
    });

    /**
     * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ddb.html
     */
    export const GetItem = makeDynamoIntegration<
      "getItem",
      <
        T extends Table<any, any, any>,
        Key extends TableKey<
          Item<T>,
          PartitionKey<T>,
          RangeKey<T>,
          JsonFormat.AttributeValue
        >,
        AttributesToGet extends keyof Item<T> | undefined = undefined,
        ProjectionExpression extends string | undefined = undefined
      >(
        input: { TableName: T } & Omit<
          GetItemInput<
            Item<T>,
            PartitionKey<T>,
            RangeKey<T>,
            Key,
            AttributesToGet,
            ProjectionExpression,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => GetItemOutput<
        Item<T>,
        PartitionKey<T>,
        RangeKey<T>,
        Key,
        AttributesToGet,
        ProjectionExpression,
        JsonFormat.AttributeValue
      >
    >("getItem", {
      native: {
        bind: (context: Function<any, any>, table: AnyTable) => {
          table.resource.grantReadData(context.resource);
        },
        call: async (
          args: [
            { TableName: AnyTable } & Omit<
              GetItemInput<
                Item<AnyTable>,
                PartitionKey<AnyTable>,
                RangeKey<AnyTable>,
                any,
                any,
                any,
                any
              >,
              "TableName"
            >
          ],
          preWarmContext: NativePreWarmContext
        ) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, AttributesToGet, ...rest } = input;

          const payload = {
            ...rest,
            AttributesToGet: AttributesToGet as any,
            TableName: table.resource.tableName,
          };

          return dynamo.getItem(payload).promise();
        },
        // Typesafe DynamoDB was causing a "excessive depth error"
      } as any,
    });

    /**
     * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ddb.html
     */
    export const UpdateItem = makeDynamoIntegration<
      "updateItem",
      <
        T extends Table<any, any, any>,
        Key extends TableKey<
          Item<T>,
          PartitionKey<T>,
          RangeKey<T>,
          JsonFormat.AttributeValue
        >,
        UpdateExpression extends string,
        ConditionExpression extends string | undefined = undefined,
        ReturnValue extends AWSDynamoDB.ReturnValue = "NONE"
      >(
        input: { TableName: T } & Omit<
          UpdateItemInput<
            Item<T>,
            PartitionKey<T>,
            RangeKey<T>,
            Key,
            UpdateExpression,
            ConditionExpression,
            ReturnValue,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => UpdateItemOutput<
        Item<T>,
        PartitionKey<T>,
        RangeKey<T>,
        Key,
        ReturnValue,
        JsonFormat.AttributeValue
      >
    >("updateItem", {
      native: {
        bind: (context, table) => {
          table.resource.grantWriteData(context.resource);
        },
        call: async (args, preWarmContext) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, ...rest } = input;

          return dynamo
            .updateItem({
              ...rest,
              TableName: table.resource.tableName,
            })
            .promise();
        },
      },
    });

    /**
     * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ddb.html
     */
    export const PutItem = makeDynamoIntegration<
      "putItem",
      <
        T extends Table<any, any, any>,
        I extends Item<T>,
        ConditionExpression extends string | undefined = undefined,
        ReturnValue extends AWSDynamoDB.ReturnValue = "NONE"
      >(
        input: { TableName: T } & Omit<
          PutItemInput<
            Item<T>,
            ConditionExpression,
            ReturnValue,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => PutItemOutput<I, ReturnValue, JsonFormat.AttributeValue>
    >("putItem", {
      native: {
        bind: (context, table) => {
          table.resource.grantWriteData(context.resource);
        },
        call: async (args, preWarmContext) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, Item, ...rest } = input;

          return dynamo
            .putItem({
              ...rest,
              Item: Item as any,
              TableName: table.resource.tableName,
            })
            .promise();
        },
      },
    });

    export const Query = makeDynamoIntegration<
      "query",
      <
        T extends Table<any, any, any>,
        KeyConditionExpression extends string,
        FilterExpression extends string | undefined = undefined,
        ProjectionExpression extends string | undefined = undefined,
        AttributesToGet extends keyof Item<T> | undefined = undefined
      >(
        input: { TableName: T } & Omit<
          QueryInput<
            Item<T>,
            KeyConditionExpression,
            FilterExpression,
            ProjectionExpression,
            AttributesToGet,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => QueryOutput<Item<T>, AttributesToGet, JsonFormat.AttributeValue>
    >("query", {
      native: {
        bind: (context, table) => {
          table.resource.grantReadData(context.resource);
        },
        call: async (args, preWarmContext) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, AttributesToGet, ...rest } = input;

          return dynamo
            .query({
              ...rest,
              AttributesToGet: AttributesToGet as any,
              TableName: table.resource.tableName,
            })
            .promise();
        },
      },
    });

    export const Scan = makeDynamoIntegration<
      "scan",
      <
        T extends Table<any, any, any>,
        FilterExpression extends string | undefined = undefined,
        ProjectionExpression extends string | undefined = undefined,
        AttributesToGet extends keyof Item<T> | undefined = undefined
      >(
        input: { TableName: T } & Omit<
          ScanInput<
            Item<T>,
            FilterExpression,
            ProjectionExpression,
            AttributesToGet,
            JsonFormat.AttributeValue
          >,
          "TableName"
        >
      ) => ScanOutput<Item<T>, AttributesToGet, JsonFormat.AttributeValue>
    >("scan", {
      native: {
        bind: (context, table) => {
          table.resource.grantReadData(context.resource);
        },
        call: async (args, preWarmContext) => {
          const dynamo = preWarmContext.getOrInit<
            TypeSafeDynamoDBv2<
              Item<AnyTable>,
              PartitionKey<AnyTable>,
              RangeKey<AnyTable>
            >
          >(PrewarmClients.DYNAMO);

          const [input] = args;

          const { TableName: table, AttributesToGet, ...rest } = input;

          return dynamo
            .scan({
              ...rest,
              AttributesToGet: AttributesToGet as any,
              TableName: table.resource.tableName,
            })
            .promise();
        },
      },
    });

    type OperationName =
      | "deleteItem"
      | "getItem"
      | "putItem"
      | "updateItem"
      | "scan"
      | "query";

    function makeDynamoIntegration<
      Op extends OperationName,
      F extends AnyFunction
    >(
      operationName: Op,
      integration: Omit<
        IntegrationInput<`$AWS.DynamoDB.${Op}`, F>,
        "kind" | "native"
      > & {
        native: Omit<NativeIntegration<F>, "preWarm" | "bind"> & {
          bind: (context: Function<any, any>, table: AnyTable) => void;
        };
      }
    ) {
      return makeIntegration<`$AWS.DynamoDB.${Op}`, F>({
        ...integration,
        kind: `$AWS.DynamoDB.${operationName}`,
        asl(call, context) {
          const input = call.getArgument("input")?.expr;
          if (!isObjectLiteralExpr(input)) {
            throw new Error(
              `input parameter must be an ObjectLiteralExpr, but was ${input?.kind}`
            );
          }
          const tableProp = (input as ObjectLiteralExpr).getProperty(
            "TableName"
          );

          if (
            tableProp?.kind !== "PropAssignExpr" ||
            tableProp.expr.kind !== "ReferenceExpr"
          ) {
            throw new Error("");
          }

          const table = tableProp.expr.ref();
          if (!isTable(table)) {
            throw new Error("");
          }
          if (
            operationName === "deleteItem" ||
            operationName === "putItem" ||
            operationName === "updateItem"
          ) {
            table.resource.grantWriteData(context.role);
          } else {
            table.resource.grantReadData(context.role);
          }

          return {
            Type: "Task",
            Resource: `arn:aws:states:::aws-sdk:dynamodb:${operationName}`,
            Parameters: ASL.toJson(input),
          };
        },
        native: {
          ...integration.native,
          bind: (context, args) => {
            const table = getTableArgument(args);
            integration.native.bind(context, table);
          },
          preWarm(prewarmContext) {
            prewarmContext.getOrInit(PrewarmClients.DYNAMO);
          },
        },
        unhandledContext(kind, contextKind) {
          throw new Error(
            `${kind} is only available within an '${ASL.ContextName}' context, but was called from within a '${contextKind}' context.`
          );
        },
      });

      function getTableArgument(args: Expr[]) {
        const [inputArgument] = args;
        // integ(input: { TableName })
        if (!inputArgument || !isObjectLiteralExpr(inputArgument)) {
          throw Error(
            `First argument into deleteItem should be an input object, found ${inputArgument?.kind}`
          );
        }

        const tableProp = inputArgument.getProperty("TableName");

        if (!tableProp || !isPropAssignExpr(tableProp)) {
          throw Error(
            `First argument into deleteItem should be an input with a property TableName that is a Table.`
          );
        }

        const tableRef = tableProp.expr;

        if (!isReferenceExpr(tableRef)) {
          throw Error(
            `First argument into deleteItem should be an input with a property TableName that is a Table.`
          );
        }

        const table = tableRef.ref();
        if (!isTable(table)) {
          throw Error(`TableName argument should be a Table object.`);
        }

        return table;
      }
    }
  }

  export namespace Lambda {
    /**
     * @param input
     * @see https://docs.aws.amazon.com/lambda/latest/dg/API_Invoke.html
     */
    export const Invoke = makeIntegration<
      "Lambda.Invoke",
      <Input, Output>(input: {
        FunctionName: Function<Input, Output>;
        Payload: Input;
        ClientContext?: string;
        InvocationType?: "Event" | "RequestResponse" | "DryRun";
        LogType?: "None" | "Tail";
        Qualifier?: string;
      }) => Omit<AWS.Lambda.InvocationResponse, "payload"> & {
        Payload: Output;
      }
    >({
      kind: "Lambda.Invoke",
      asl(call) {
        const input = call.args[0].expr;
        if (input === undefined) {
          throw new Error("missing argument 'input'");
        } else if (input.kind !== "ObjectLiteralExpr") {
          throw new Error("argument 'input' must be an ObjectLiteralExpr");
        }
        const functionName = input.getProperty("FunctionName")?.expr;
        if (functionName === undefined) {
          throw new Error("missing required property 'FunctionName'");
        } else if (functionName.kind !== "ReferenceExpr") {
          throw new Error(
            "property 'FunctionName' must reference a functionless.Function"
          );
        }
        const functionRef = functionName.ref();
        if (!isFunction(functionRef)) {
          throw new Error(
            "property 'FunctionName' must reference a functionless.Function"
          );
        }
        const payload = input.getProperty("Payload")?.expr;
        if (payload === undefined) {
          throw new Error("missing property 'payload'");
        }
        return {
          Type: "Task",
          Resource: "arn:aws:states:::lambda:invoke",
          Parameters: {
            FunctionName: functionRef.resource.functionName,
            [`Payload${payload && isVariableReference(payload) ? ".$" : ""}`]:
              payload ? ASL.toJson(payload) : null,
          },
        };
      },
      unhandledContext(kind, contextKind) {
        throw new Error(
          `$AWS.${kind} is only available within an '${ASL.ContextName}' context, but was called from within a '${contextKind}' context.`
        );
      },
    });
  }

  export namespace EventBridge {
    /**
     * @see https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
     */
    export const putEvents = makeIntegration<
      "EventBridge.putEvent",
      (
        request: AWS.EventBridge.Types.PutEventsRequest
      ) => AWS.EventBridge.Types.PutEventsResponse
    >({
      kind: "EventBridge.putEvent",
      native: {
        // Access needs to be granted manually
        bind: () => {},
        preWarm: (prewarmContext: NativePreWarmContext) => {
          prewarmContext.getOrInit(PrewarmClients.EVENT_BRIDGE);
        },
        call: async ([request], preWarmContext) => {
          const eventBridge = preWarmContext.getOrInit<EventBridge>(
            PrewarmClients.EVENT_BRIDGE
          );
          return eventBridge
            .putEvents({
              Entries: request.Entries.map((e) => ({
                ...e,
              })),
            })
            .promise();
        },
      },
    });
  }
}
