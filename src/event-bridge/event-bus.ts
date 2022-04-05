import { aws_events } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ASL, isASL, Task } from "../asl";
import { makeCallable } from "../callable";
import { CallContext } from "../context";
import {
  CallExpr,
  Expr,
  Identifier,
  isArrayLiteralExpr,
  isComputedPropertyNameExpr,
  isIdentifier,
  isObjectLiteralExpr,
  isSpreadAssignExpr,
  ObjectLiteralExpr,
  PropAssignExpr,
  StringLiteralExpr,
} from "../expression";
import { EventBusRule, EventPredicateFunction, IEventBusRule } from "./rule";
import { EventBusRuleInput } from "./types";

export const isEventBus = <E extends EventBusRuleInput>(
  v: any
): v is IEventBus<E> => {
  return (
    "functionlessKind" in v &&
    v.functionlessKind === EventBusBase.FunctionlessType
  );
};

export interface IEventBus<E extends EventBusRuleInput> {
  readonly bus: aws_events.IEventBus;

  /**
   * This static property identifies this class as an EventBus to the TypeScript plugin.
   */
  readonly functionlessKind: typeof EventBusBase.FunctionlessType;

  /**
   * EventBus Rules can filter events using Functionless predicate functions.
   *
   * Equals
   *
   * ```ts
   * when(this, 'rule', (event) => event.source === "lambda")
   * ```
   *
   * Starts With (Prefix)
   *
   * ```ts
   * when(this, 'rule', (event) => event.id.startsWith("2022"))
   * ```
   *
   * Not
   *
   * ```ts
   * when(this, 'rule', (event) => event.source !== "dynamo")
   * ```
   *
   * Numeric Ranges
   *
   * ```ts
   * when(this, 'rule', (event) => event.detail.num >= 10 || event.detail.num > 100 && event.detail.num < 1000)
   * ```
   *
   * Presence
   *
   * ```ts
   * when(this, 'rule', (event) => !event.detail.optional)
   * ```
   *
   * Multiple Fields
   *
   * ```ts
   * when(this, 'rule', (event) => event.source === "lambda" && event['detail-type'] === "SUCCESS")
   * ```
   *
   * Array Includes
   *
   * ```ts
   * when(this, 'rule', (event) => event.detail.list.includes("someValue"))
   * ```
   *
   * Unsupported by Event Bridge
   * * OR Logic between multiple fields
   * * AND logic between most logic on a single field (except for numeric ranges.)
   * * Multiple `!field.startsWith(...)` on a single field
   * * Any operation on an Array other than `includes` and presence (`event.detail.list === undefined`).
   * * Any string operation other than `===/==`, `!==/!=`, `startsWith`, and presence (`!==/=== undefined`).
   * * Math (`event.detail.num + 1 < 10`)
   * * Comparisons between fields (`event.detail.previous !== event.id`)
   *
   * Unsupported by Functionless:
   * * Variables from outside of the function scope
   */
  when(
    scope: Construct,
    id: string,
    predicate: EventPredicateFunction<E>
  ): EventBusRule<E>;

  /**
   * Put one or more events on an Event Bus.
   */
  (...events: Partial<E>[]): void;
}
abstract class EventBusBase<E extends EventBusRuleInput>
  implements IEventBus<E>
{
  /**
   * This static properties identifies this class as an EventBus to the TypeScript plugin.
   */
  public static readonly FunctionlessType = "EventBus";
  readonly functionlessKind = "EventBus";

  readonly bus: aws_events.IEventBus;

  constructor(bus: aws_events.IEventBus) {
    this.bus = bus;
    return makeCallable(this, (call: CallExpr, context: CallContext) => {
      if (isASL(context)) {
        this.bus.grantPutEventsTo(context.role);

        // Lets validate and normalize that the events are
        const eventObjs = call.args.reduce(
          (events: ObjectLiteralExpr[], arg) => {
            if (isArrayLiteralExpr(arg.expr)) {
              if (
                !arg.expr.items.every((item): item is ObjectLiteralExpr =>
                  isObjectLiteralExpr(item)
                )
              ) {
                throw Error(
                  "Event Bus put events must use inline object parameters. Variable references are not supported currently."
                );
              }
              return [...events, ...arg.expr.items];
            } else if (isObjectLiteralExpr(arg.expr)) {
              return [...events, arg.expr];
            }
            throw Error(
              "Event Bus put events must use inline object parameters. Variable references are not supported currently."
            );
          },
          []
        );

        // The interface should prevent this.
        if (eventObjs.length === 0) {
          throw Error("Must provide at least one event.");
        }

        const propertyMap: Record<keyof EventBusRuleInput, string> = {
          "detail-type": "DetailType",
          account: "Account",
          detail: "Detail",
          id: "Id",
          region: "Region",
          resources: "Resources",
          source: "Source",
          time: "Time",
          version: "Version",
        };

        const events = eventObjs.map((event) => {
          const props = event.properties.filter(
            (
              e
            ): e is PropAssignExpr & {
              name: StringLiteralExpr | Identifier;
            } => !(isSpreadAssignExpr(e) || isComputedPropertyNameExpr(e.name))
          );
          if (props.length < event.properties.length) {
            throw Error(
              "Event Bus put events must use inline objects instantiated without computed or spread keys."
            );
          }
          return (
            props
              .map(
                (prop) =>
                  [
                    isIdentifier(prop.name) ? prop.name.name : prop.name.value,
                    prop.expr,
                  ] as const
              )
              .filter(
                (x): x is [keyof typeof propertyMap, Expr] =>
                  x[0] in propertyMap && !!x[1]
              )
              /**
               * Build the parameter payload for an event entry.
               * All members must be in Pascal case.
               */
              .reduce(
                (acc: Record<string, string>, [name, expr]) => ({
                  ...acc,
                  [propertyMap[name]]: ASL.toJson(expr),
                }),
                { EventBusName: this.bus.eventBusArn }
              )
          );
        });

        const task: Task = {
          Resource: "arn:aws:states:::events:putEvents",
          Type: "Task",
          Parameters: {
            Entries: events,
          },
        };

        return task;
      }

      throw Error(`Event Bridge integration not supported on ${context.kind}`);
    });
  }

  /**
   * @inheritdoc
   */
  when(
    scope: Construct,
    id: string,
    predicate: EventPredicateFunction<E>
  ): IEventBusRule<E> {
    return new EventBusRule<E>(scope, id, this, predicate);
  }
}

interface EventBusBase<E extends EventBusRuleInput> {
  (event: Partial<E>, ...events: Partial<E>[]): void;
}

/**
 * A Functionless wrapper for a AWS CDK {@link aws_events.EventBus}.
 *
 * Wrap your {@link aws_events.EventBus} instance with this class,
 * specify a type to represent the events passing through the EventBus,
 * and then use the .when, .map and .pipe functions to express
 * EventBus Event Patterns and Targets Inputs with native TypeScript syntax.
 *
 * Filtering events and sending them to Lambda.
 *
 * ```ts
 * interface Payload {
 *    value: string;
 * }
 *
 * // An event with the payload
 * interface myEvent extends EventBusRuleInput<Payload> {}
 *
 * const myAwsFunction = new aws_lambda.Function(this, 'myFunction', { ... });
 * // A function that expects the payload.
 * const myLambdaFunction = new functionless.Function<Payload, void>(myAwsFunction);
 *
 * // instantiate an aws_events.EventBus Construct
 * const awsBus = new aws_events.EventBus(this, "mybus");
 *
 * // Wrap the aws_events.EventBus with the functionless.EventBus
 * new functionless.EventBus<myEvent>(awsBus)
 *    // when the payload is equal to some value
 *    .when(this, 'rule1', event => event.detail.value === "some value")
 *    // grab the payload
 *    .map(event => event.detail)
 *    // send to the function
 *    .pipe(myLambdaFunction);
 * ```
 *
 * Forwarding to another Event Bus based on some predicate:
 *
 * ```ts
 * // Using an imported event bus
 * const anotherEventBus = aws_event.EventBus.fromEventBusArn(...);
 *
 * new functionless.EventBus<myEvent>(awsBus)
 *    // when the payload is equal to some value
 *    .when(this, 'rule2', event => event.detail.value === "some value")
 *    // send verbatim to the other event bus
 *    .pipe(anotherEventBus);
 * ```
 */
export class EventBus<E extends EventBusRuleInput> extends EventBusBase<E> {
  constructor(scope: Construct, id: string, props?: aws_events.EventBusProps) {
    super(new aws_events.EventBus(scope, id, props));
  }

  /**
   * Import an {@link aws_events.IEventBus} wrapped with Functionless abilities.
   */
  static fromBus<E extends EventBusRuleInput>(
    bus: aws_events.IEventBus
  ): IEventBus<E> {
    return new ImportedEventBus<E>(bus);
  }
}

class ImportedEventBus<E extends EventBusRuleInput> extends EventBusBase<E> {
  constructor(bus: aws_events.IEventBus) {
    super(bus);
  }
}