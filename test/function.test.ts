import { App, aws_lambda, Stack } from "aws-cdk-lib";
import "jest";
import {
  Function,
  AppsyncContext,
  reflect,
  EventBus,
  AsyncFunctionResponseEvent,
  AsyncResponseSuccess,
  AsyncResponseFailure,
} from "../src";
import { VTL } from "../src/vtl";
import { appsyncTestCase } from "./util";

interface Item {
  id: string;
  name: number;
}

let stack: Stack;
let lambda: aws_lambda.Function;

beforeEach(() => {
  const app = new App({ autoSynth: false });
  stack = new Stack(app, "stack");

  lambda = new aws_lambda.Function(stack, "F", {
    code: aws_lambda.Code.fromInline(
      "exports.handler = function() { return null; }"
    ),
    handler: "index.handler",
    runtime: aws_lambda.Runtime.NODEJS_14_X,
  });
});

test("call function", () => {
  const fn1 = Function.fromFunction<{ arg: string }, Item>(lambda);

  return appsyncTestCase(
    reflect((context: AppsyncContext<{ arg: string }>) => {
      return fn1(context.arguments);
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $context.arguments})
$util.toJson($v1)`,
    // function's response mapping template
    `#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end`
  );
});

test("call function and conditional return", () => {
  const fn1 = Function.fromFunction<{ arg: string }, Item>(lambda);

  appsyncTestCase(
    reflect((context: AppsyncContext<{ arg: string }>) => {
      const result = fn1(context.arguments);

      if (result.id === "sam") {
        return true;
      } else {
        return false;
      }
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $context.arguments})
$util.toJson($v1)`,
    // function's response mapping template
    `#set( $context.stash.result = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end
#set($v1 = $context.stash.result.id == 'sam')
#if($v1)
#set($context.stash.return__val = true)
#set($context.stash.return__flag = true)
#return($context.stash.return__val)
#else
#set($context.stash.return__val = false)
#set($context.stash.return__flag = true)
#return($context.stash.return__val)
#end`
  );
});

test("call function omitting optional arg", () => {
  const fn2 = Function.fromFunction<{ arg: string; optional?: string }, Item>(
    lambda
  );
  appsyncTestCase(
    reflect((context: AppsyncContext<{ arg: string }>) => {
      return fn2(context.arguments);
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $context.arguments})
$util.toJson($v1)`,
    // function's response mapping template
    `#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end`
  );
});

test("call function including optional arg", () => {
  const fn2 = Function.fromFunction<{ arg: string; optional?: string }, Item>(
    lambda
  );

  appsyncTestCase(
    reflect((context: AppsyncContext<{ arg: string }>) => {
      return fn2({ arg: context.arguments.arg, optional: "hello" });
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {})
$util.qr($v1.put('arg', $context.arguments.arg))
$util.qr($v1.put('optional', 'hello'))
#set($v2 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $v1})
$util.toJson($v2)`,
    // function's response mapping template
    `#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end`
  );
});

test("call function including with no parameters", () => {
  const fn3 = Function.fromFunction<undefined, Item>(lambda);

  return appsyncTestCase(
    reflect(() => {
      return fn3();
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $null})
$util.toJson($v1)`,
    // function's response mapping template
    `#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end`
  );
});

test("call function including with void result", () => {
  const fn4 = Function.fromFunction<{ arg: string }, void>(lambda);

  return appsyncTestCase(
    reflect((context: AppsyncContext<{ arg: string }>) => {
      return fn4(context.arguments);
    }),
    // pipeline's request mapping template
    "{}",
    // function's request mapping template
    `${VTL.CircuitBreaker}
#set($v1 = {\"version\": \"2018-05-29\", \"operation\": \"Invoke\", \"payload\": $context.arguments})
$util.toJson($v1)`,
    // function's response mapping template
    `#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = $context.result )
{}`,
    // response mapping template
    `#if($context.stash.return__flag)
  #return($context.stash.return__val)
#end`
  );
});

test("set on success bus", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus"
  );
  const func = new Function<string, void>(
    stack,
    "func2",
    {
      onSuccess: bus,
    },
    async () => {}
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnSuccessProperty>(
      (<aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
        (<aws_lambda.CfnEventInvokeConfig>(
          (<aws_lambda.EventInvokeConfig>(
            func.resource.node.tryFindChild("EventInvokeConfig")
          ))?.node?.tryFindChild("Resource")
        ))?.destinationConfig
      ))?.onSuccess
    )).destination
  ).toEqual(bus.bus.eventBusArn);
});

test("set on failure bus", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus2"
  );
  const func = new Function<string, void>(
    stack,
    "func3",
    {
      onFailure: bus,
    },
    async () => {}
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>(
      (<aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
        (<aws_lambda.CfnEventInvokeConfig>(
          (<aws_lambda.EventInvokeConfig>(
            func.resource.node.tryFindChild("EventInvokeConfig")
          ))?.node?.tryFindChild("Resource")
        ))?.destinationConfig
      ))?.onFailure
    )).destination
  ).toEqual(bus.bus.eventBusArn);
});

test("set on success function", () => {
  const onSuccessFunction = new Function<
    AsyncResponseSuccess<string, void>,
    void
  >(stack, "func", async () => {});
  const func = new Function<string, void>(
    stack,
    "func2",
    {
      onSuccess: onSuccessFunction,
    },
    async () => {}
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnSuccessProperty>(
      (<aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
        (<aws_lambda.CfnEventInvokeConfig>(
          (<aws_lambda.EventInvokeConfig>(
            func.resource.node.tryFindChild("EventInvokeConfig")
          ))?.node?.tryFindChild("Resource")
        ))?.destinationConfig
      ))?.onSuccess
    )).destination
  ).toEqual(onSuccessFunction.resource.functionArn);
});

test("set on failure function", () => {
  const onFailureFunction = new Function<AsyncResponseFailure<string>, void>(
    stack,
    "func",
    async () => {}
  );
  const func = new Function<string, void>(
    stack,
    "func3",
    {
      onFailure: onFailureFunction,
    },
    async () => {}
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>(
      (<aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
        (<aws_lambda.CfnEventInvokeConfig>(
          (<aws_lambda.EventInvokeConfig>(
            func.resource.node.tryFindChild("EventInvokeConfig")
          ))?.node?.tryFindChild("Resource")
        ))?.destinationConfig
      ))?.onFailure
    )).destination
  ).toEqual(onFailureFunction.resource.functionArn);
});

test("configure async with functions", () => {
  const handleAsyncFunction = new Function<
    AsyncResponseFailure<string> | AsyncResponseSuccess<string, void>,
    void
  >(stack, "func", async () => {});
  const func = new Function<string, void>(stack, "func3", async () => {});

  func.enableAsyncInvoke({
    onFailure: handleAsyncFunction,
    onSuccess: handleAsyncFunction,
  });

  const config = <aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
    (<aws_lambda.CfnEventInvokeConfig>(
      (<aws_lambda.EventInvokeConfig>(
        func.resource.node.tryFindChild("EventInvokeConfig")
      ))?.node?.tryFindChild("Resource")
    ))?.destinationConfig
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>config?.onFailure)
      .destination
  ).toEqual(handleAsyncFunction.resource.functionArn);
  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>config?.onSuccess)
      .destination
  ).toEqual(handleAsyncFunction.resource.functionArn);
});

test("configure async with bus", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus2"
  );
  const func = new Function<string, void>(stack, "func3", async () => {});

  func.enableAsyncInvoke({
    onFailure: bus,
    onSuccess: bus,
  });

  const config = <aws_lambda.CfnEventInvokeConfig.DestinationConfigProperty>(
    (<aws_lambda.CfnEventInvokeConfig>(
      (<aws_lambda.EventInvokeConfig>(
        func.resource.node.tryFindChild("EventInvokeConfig")
      ))?.node?.tryFindChild("Resource")
    ))?.destinationConfig
  );

  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>config?.onFailure)
      .destination
  ).toEqual(bus.bus.eventBusArn);
  expect(
    (<aws_lambda.CfnEventInvokeConfig.OnFailureProperty>config?.onSuccess)
      .destination
  ).toEqual(bus.bus.eventBusArn);
});

test("set on success rule", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus3"
  );
  const func = new Function<string, void>(stack, "func3", async () => {});
  const onSuccess = func.onSuccess(bus, "funcSuccess");
  onSuccess.pipe(bus);

  expect(onSuccess.rule._renderEventPattern()).toEqual({
    source: ["lambda"],
    "detail-type": ["Lambda Function Invocation Result - Success"],
    resources: [func.resource.functionArn],
  });
});

test("set on failure rule", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus3"
  );
  const func = new Function<string, void>(stack, "func3", async () => {});
  const onFailure = func.onFailure(bus, "funcFailure");
  onFailure.pipe(bus);

  expect(onFailure.rule._renderEventPattern()).toEqual({
    source: ["lambda"],
    "detail-type": ["Lambda Function Invocation Result - Failure"],
    resources: [func.resource.functionArn],
  });
});

test("onFailure().pipe should type check", () => {
  const bus = new EventBus<AsyncFunctionResponseEvent<string, void>>(
    stack,
    "bus3"
  );
  const func = new Function<number, void>(stack, "func3", async () => {});
  // @ts-expect-error
  const onFailure = func.onFailure(bus, "funcFailure");
  // @ts-expect-error
  const onSuccess = func.onSuccess(bus, "funcSuccess");
  // @ts-expect-error
  onFailure.pipe(bus);
  // @ts-expect-error
  onSuccess.pipe(bus);

  expect(onFailure.rule._renderEventPattern()).toEqual({
    source: ["lambda"],
    "detail-type": ["Lambda Function Invocation Result - Failure"],
    resources: [func.resource.functionArn],
  });
});

test("function inline arrow closure", () => {
  new Function(stack, "inline", async (p: string) => p);
});

test("function block closure", () => {
  new Function(stack, "block", async (p: string) => {
    return p;
  });
});

test("function accepts a superset of primitives", () => {
  const func1 = new Function(stack, "superset", async (p: string | number) => {
    return p;
  });

  new Function(
    stack,
    "subset",
    async (p: { sn: string | number; b: boolean; bs: boolean | string }) => {
      func1("hello");
      func1(1);
      func1(p.sn);
      // @ts-expect-error - func1 accepts a string or number
      func1(p.b);
      if (typeof p.bs === "string") {
        func1(p.bs);
      }
    }
  );
});

test("function accepts a superset of objects", () => {
  const func1 = new Function(
    stack,
    "superset",
    async (p: { a: string } | { b: string }) => {
      return p;
    }
  );

  new Function(
    stack,
    "subset",
    async (p: {
      a: { a: string };
      b: { b: string };
      ab: { a: string } | { b: string };
      aabb: { a: string; b: string };
      c: { c: string };
      ac: { a: string; c: string };
    }) => {
      func1(p.a);
      func1(p.b);
      func1(p.ab);
      func1(p.aabb);
      // @ts-expect-error - func1 requires a or b
      func1(p.c);
      func1(p.ac);
    }
  );
});
