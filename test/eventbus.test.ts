import {
  aws_events,
  aws_events_targets,
  aws_lambda,
  Duration,
  Stack,
} from "aws-cdk-lib";
import { ExpressStepFunction, StepFunction } from "../src";
import { EventBus, Rule, Event, ScheduledEvent } from "../src/event-bridge";
import { synthesizeEventPattern } from "../src/event-bridge/event-pattern";
import { EventTransform } from "../src/event-bridge/transform";
import { Function } from "../src/function";

let stack: Stack;

beforeEach(() => {
  stack = new Stack();
});

test("new bus from aws bus", () => {
  const bus = new aws_events.EventBus(stack, "bus");

  EventBus.fromBus(bus);
});

test("new bus without wrapper", () => {
  new EventBus(stack, "bus");
});

test("new rule without when", () => {
  const bus = new EventBus(stack, "bus");

  const rule = new Rule(stack, "rule", bus, (_event) => true);

  expect(rule.rule._renderEventPattern()).toEqual({ source: [{ prefix: "" }] });
});

test("new transform without map", () => {
  const bus = new EventBus(stack, "bus");

  const rule = new Rule(stack, "rule", bus, (_event) => true);
  const transform = new EventTransform((event) => event.source, rule);

  expect(transform.targetInput.bind(rule.rule)).toEqual({
    inputPath: "$.source",
  } as aws_events.RuleTargetInputProperties);
});

test("rule from existing rule", () => {
  const awsRule = new aws_events.Rule(stack, "rule");

  const rule = Rule.fromRule(awsRule);
  const transform = new EventTransform((event) => event.source, rule);

  expect(transform.targetInput.bind(rule.rule)).toEqual({
    inputPath: "$.source",
  } as aws_events.RuleTargetInputProperties);
});

test("new bus with when", () => {
  const rule = new EventBus(stack, "bus").when(stack, "rule", () => true);

  expect(rule.rule._renderEventPattern()).toEqual({ source: [{ prefix: "" }] });
});

test("when using auto-source", () => {
  const bus = new EventBus(stack, "bus");
  bus.when("rule", () => true).pipe(bus);

  expect(bus.bus.node.tryFindChild("rule")).not.toBeUndefined();
});

test("rule when using auto-source", () => {
  const bus = new EventBus(stack, "bus");
  const rule1 = bus.when("rule", () => true);
  rule1.when("rule2", () => true).pipe(bus);

  expect(bus.bus.node.tryFindChild("rule2")).not.toBeUndefined();
});

test("refine rule", () => {
  const rule = new EventBus(stack, "bus").when(
    stack,
    "rule",
    (event) => event.source === "lambda"
  );
  const rule2 = rule.when(
    stack,
    "rule1",
    (event) => event["detail-type"] === "something"
  );

  expect(rule2.rule._renderEventPattern()).toEqual({
    source: ["lambda"],
    "detail-type": ["something"],
  });
});

test("new bus with when pipe event bus", () => {
  const busBus = new EventBus(stack, "bus");

  const rule = busBus.when(stack, "rule", () => true);
  rule.pipe(busBus);

  expect((rule.rule as any).targets.length).toEqual(1);
  expect(
    (rule.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("refined bus with when pipe event bus", () => {
  const busBus = new EventBus(stack, "bus");

  const rule = busBus.when(stack, "rule", (event) => event.source === "lambda");
  const rule2 = rule.when(
    stack,
    "rule1",
    (event) => event["detail-type"] === "something"
  );
  rule2.pipe(busBus);

  expect((rule.rule as any).targets.length).toEqual(0);
  expect((rule2.rule as any).targets.length).toEqual(1);
  expect(
    (rule2.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("new bus with when map pipe function", () => {
  const busBus = new EventBus(stack, "bus");

  const func = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );

  const rule = busBus
    .when(stack, "rule", () => true)
    .map((event) => event.source);
  rule.pipe(func);

  expect(rule.targetInput.bind(rule.rule.rule)).toEqual({
    inputPath: "$.source",
  } as aws_events.RuleTargetInputProperties);
  expect((rule.rule.rule as any).targets.length).toEqual(1);
  expect(
    (rule.rule.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("refined bus with when pipe function", () => {
  const func = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const rule = new EventBus(stack, "bus").when(
    stack,
    "rule",
    (event) => event.source === "lambda"
  );
  const rule2 = rule.when(
    stack,
    "rule1",
    (event) => event["detail-type"] === "something"
  );
  const map = rule2.map((event) => event.source);
  map.pipe(func);

  expect((rule.rule as any).targets.length).toEqual(0);
  expect((rule2.rule as any).targets.length).toEqual(1);
  expect(
    (map.rule.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("new bus with when map pipe step function", () => {
  const busBus = new EventBus(stack, "bus");

  const func = new StepFunction<{ source: string }, void>(
    stack,
    "sfn",
    () => {}
  );

  const rule = busBus
    .when(stack, "rule", () => true)
    .map((event) => ({ source: event.source }));
  rule.pipe(func);

  expect(stack.resolve(rule.targetInput.bind(rule.rule.rule))).toEqual({
    inputPathsMap: { source: "$.source" },
    inputTemplate: '{"source":<source>}',
  } as aws_events.RuleTargetInputProperties);
  expect((rule.rule.rule as any).targets.length).toEqual(1);
  expect(
    (rule.rule.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("new bus with when map pipe express step function", () => {
  const busBus = new EventBus(stack, "bus");

  const func = new ExpressStepFunction<{ source: string }, void>(
    stack,
    "sfn",
    () => {}
  );

  const rule = busBus
    .when(stack, "rule", () => true)
    .map((event) => ({ source: event.source }));
  rule.pipe(func);

  expect(stack.resolve(rule.targetInput.bind(rule.rule.rule))).toEqual({
    inputPathsMap: { source: "$.source" },
    inputTemplate: '{"source":<source>}',
  } as aws_events.RuleTargetInputProperties);
  expect((rule.rule.rule as any).targets.length).toEqual(1);
  expect(
    (rule.rule.rule as any).targets[0] as aws_events.IRuleTarget
  ).toHaveProperty("arn");
});

test("new bus with when map pipe function props", () => {
  const busBus = new EventBus(stack, "bus");

  const func = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );

  const rule = busBus
    .when(stack, "rule", () => true)
    .map((event) => event.source);
  rule.pipe(func, { retryAttempts: 10 });

  expect(rule.targetInput.bind(rule.rule.rule)).toEqual({
    inputPath: "$.source",
  } as aws_events.RuleTargetInputProperties);
  expect((rule.rule.rule as any).targets.length).toEqual(1);
  expect(
    (rule.rule.rule as any).targets[0] as aws_events.RuleTargetConfig
  ).toHaveProperty("arn");
  expect(
    ((rule.rule.rule as any).targets[0] as aws_events.RuleTargetConfig)
      .retryPolicy?.maximumRetryAttempts
  ).toEqual(10);
});

test("pipe escape hatch", () => {
  const busBus = new EventBus(stack, "bus");

  const func = Function.fromFunction(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );

  const rule = busBus.when(stack, "rule", () => true);
  rule.pipe(() => new aws_events_targets.LambdaFunction(func.resource));

  expect(
    (rule.rule as any).targets[0] as aws_events.RuleTargetConfig
  ).toHaveProperty("arn");
});

test("pipe map escape hatch", () => {
  const busBus = new EventBus(stack, "bus");

  const func = Function.fromFunction(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );

  const rule = busBus
    .when(stack, "rule", () => true)
    .map((event) => event.source);
  rule.pipe(
    (targetInput) =>
      new aws_events_targets.LambdaFunction(func.resource, {
        event: targetInput,
      })
  );

  expect(
    (rule.rule.rule as any).targets[0] as aws_events.RuleTargetConfig
  ).toHaveProperty("arn");
});

interface t1 {
  type: "one";
  one: string;
}

interface t2 {
  type: "two";
  two: string;
}

interface tt extends Event<t1 | t2> {}

test("when narrows type to map", () => {
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t1> => event.detail.type === "one"
    )
    .map((event) => event.detail.one);
});

test("when narrows type to map", () => {
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t2> => event.detail.type === "two"
    )
    .when(stack, "rule2", (event) => event.detail.two === "something");
});

test("map narrows type and pipe enforces", () => {
  const lambda = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t1> => event.detail.type === "one"
    )
    .map((event) => event.detail.one)
    .pipe(lambda);
});

test("a scheduled rule can be mapped and pipped", () => {
  const lambda = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t1> => event.detail.type === "one"
    )
    .map((event) => event.detail) // is object
    // @ts-expect-error should fail compilation if the types don't match
    .pipe(lambda); // expects strings
});

test("pipe typesafe sfn", () => {
  const sfn = new StepFunction(stack, "machine", (payload: { id: string }) => {
    return payload.id;
  });
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t1> => event.detail.type === "one"
    )
    .map((event) => ({ id: event.detail.one })) // is object
    .pipe(sfn); // expects strings
});

test("pipe typesafe error sfn", () => {
  const sfn = new StepFunction(stack, "machine", (payload: { id: string }) => {
    return payload.id;
  });
  const bus = EventBus.default<tt>(stack);

  bus
    .when(
      stack,
      "rule",
      (event): event is Event<t1> => event.detail.type === "one"
    )
    .map((event) => ({ id: event.detail })) // is object
    // @ts-expect-error
    .pipe(sfn); // expects strings
});

test("map cannot pipe to a bus", () => {
  const bus = EventBus.default<tt>(stack);

  expect(() =>
    bus
      .when(
        stack,
        "rule",
        (event): event is Event<t1> => event.detail.type === "one"
      )
      .map((event) => event)
      // @ts-expect-error
      .pipe(bus)
  ).toThrow();
});
test("pipe typesafe", () => {
  const lambda = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus

    .schedule(stack, "rule", aws_events.Schedule.rate(Duration.hours(1)))
    .map((event) => event.id)
    // should fail compilation if the types don't match
    .pipe(lambda);
});

test("a scheduled rule can be pipped", () => {
  const lambda = Function.fromFunction<ScheduledEvent, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus
    .schedule(stack, "rule", aws_events.Schedule.rate(Duration.hours(1)))
    .pipe(lambda);
});

test("when any", () => {
  const lambda = Function.fromFunction<string, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus
    .all()
    .map((event) => event.id)
    // should fail compilation if the types don't match
    .pipe(lambda);

  const rule = bus.bus.node.tryFindChild("all");
  expect(rule).not.toBeUndefined();
});

test("when any pipe", () => {
  const lambda = Function.fromFunction<Event, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus.all().pipe(lambda);

  const rule = bus.bus.node.tryFindChild("all");
  expect(rule).not.toBeUndefined();
});

test("when any multiple times does not create new rules", () => {
  const lambda = Function.fromFunction<Event, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus.all().pipe(lambda);
  bus.all().pipe(lambda);
  bus.all().pipe(lambda);

  const rule = bus.bus.node.tryFindChild("all");
  expect(rule).not.toBeUndefined();
});

test("when any pipe", () => {
  const lambda = Function.fromFunction<Event, void>(
    aws_lambda.Function.fromFunctionArn(stack, "func", "")
  );
  const bus = EventBus.default<tt>(stack);

  bus.all(stack, "anyRule").pipe(lambda);

  const rule = stack.node.tryFindChild("anyRule");
  expect(rule).not.toBeUndefined();
});

test("when any when pipe", () => {
  const bus = EventBus.default<tt>(stack);

  const rule = bus
    .all(stack, "anyRule")
    .when("rule1", (event) => event.id === "test");

  expect(synthesizeEventPattern(rule.document)).toEqual({ id: ["test"] });
});
