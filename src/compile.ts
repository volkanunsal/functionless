import ts from "typescript";
import path from "path";
import { PluginConfig, TransformerExtras } from "ts-patch";
import { BinaryOp, CanReference } from "./expression";
import { FunctionlessNode } from "./node";
import { AppsyncResolver } from "./appsync";
import { assertDefined } from "./assert";
import { StepFunction, ExpressStepFunction } from "./step-function";
import { hasParent } from "./util";
import minimatch from "minimatch";
import { EventBus, EventBusRule } from "./event-bridge";
import { EventBusTransform } from "./event-bridge/transform";
import { Function } from "./function";

export default compile;

/**
 * Configuration options for the functionless TS transform.
 */
export interface FunctionlessConfig extends PluginConfig {
  /**
   * Glob to exclude
   */
  exclude?: string[];
}

/**
 * TypeScript Transformer which transforms functionless functions, such as `AppsyncResolver`,
 * into an AST that can be interpreted at CDK synth time to produce VTL templates and AppSync
 * Resolver configurations.
 *
 * @param program the TypeScript {@link ts.Program}
 * @param config the {@link FunctionlessConfig}.
 * @param _extras
 * @returns the transformer
 */
export function compile(
  program: ts.Program,
  _config?: FunctionlessConfig,
  _extras?: TransformerExtras
): ts.TransformerFactory<ts.SourceFile> {
  const excludeMatchers = _config?.exclude
    ? _config.exclude.map((pattern) => minimatch.makeRe(path.resolve(pattern)))
    : [];
  const checker = program.getTypeChecker();
  return (ctx) => {
    const functionless = ts.factory.createUniqueName("functionless");
    const awsClient = ts.factory.createUniqueName("aws");
    return (sf) => {
      // const imports = sf.statements
      //   .filter(
      //     (
      //       s
      //     ): s is ts.ImportDeclaration & {
      //       moduleSpecifier: ts.StringLiteral;
      //     } =>
      //       ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
      //   )
      //   .reduce(
      //     (acc: Record<string, ts.ImportDeclaration>, d) => ({
      //       ...acc,
      //       [d.moduleSpecifier.text]: d,
      //     }),
      //     {}
      //   );

      // Do not transform any of the files matched by "exclude"
      if (excludeMatchers.some((matcher) => matcher.test(sf.fileName))) {
        return sf;
      }

      const functionlessImport = ts.factory.createImportDeclaration(
        undefined,
        undefined,
        ts.factory.createImportClause(
          false,
          undefined,
          ts.factory.createNamespaceImport(functionless)
        ),
        ts.factory.createStringLiteral("functionless")
      );

      // TODO: do this dynamically based on need.
      // TODO: use aws sdk 3?
      const awsImport = ts.factory.createImportDeclaration(
        undefined,
        undefined,
        ts.factory.createImportClause(
          false,
          undefined,
          ts.factory.createNamespaceImport(awsClient)
        ),
        ts.factory.createStringLiteral("aws-sdk")
      );

      return ts.factory.updateSourceFile(
        sf,
        [
          functionlessImport,
          awsImport,
          ...(sf.statements.flatMap((stmt) => visitor(stmt)) as ts.Statement[]),
        ],
        sf.isDeclarationFile,
        sf.referencedFiles,
        sf.typeReferenceDirectives,
        sf.hasNoDefaultLib,
        sf.libReferenceDirectives
      );

      function visitor(node: ts.Node): ts.Node | ts.Node[] {
        const visit = () => {
          if (isAppsyncResolver(node)) {
            return visitAppsyncResolver(node as ts.NewExpression);
          } else if (isStepFunction(node)) {
            return visitStepFunction(node as ts.NewExpression);
          } else if (isReflectFunction(node)) {
            return errorBoundary(() =>
              toFunction("FunctionDecl", node.arguments[0])
            );
          } else if (isEventBusWhenFunction(node)) {
            return visitEventBusWhen(node);
          } else if (isEventBusRuleMapFunction(node)) {
            return visitEventBusMap(node);
          } else if (isNewEventBusRule(node)) {
            return visitEventBusRule(node);
          } else if (isNewEventBusTransform(node)) {
            return visitEventTransform(node);
          } else if (isNewFunctionlessFunction(node)) {
            return visitFunction(node, ctx);
          }
          return node;
        };
        // keep processing the children of the updated node.
        return ts.visitEachChild(visit(), visitor, ctx);
      }

      function isReflectFunction(node: ts.Node): node is ts.CallExpression & {
        arguments: [TsFunctionParameter, ...ts.Expression[]];
      } {
        if (ts.isCallExpression(node)) {
          const exprType = checker.getTypeAtLocation(node.expression);
          const exprDecl = exprType.symbol?.declarations?.[0];
          if (exprDecl && ts.isFunctionDeclaration(exprDecl)) {
            if (exprDecl.name?.text === "reflect") {
              return true;
            }
          }
        }
        return false;
      }

      function isAppsyncResolver(node: ts.Node): node is ts.NewExpression & {
        arguments: [TsFunctionParameter, ...ts.Expression[]];
      } {
        if (ts.isNewExpression(node)) {
          return isFunctionlessClassOfKind(
            node.expression,
            AppsyncResolver.FunctionlessType
          );
        }
        return false;
      }

      function isStepFunction(node: ts.Node): node is ts.NewExpression & {
        arguments: [TsFunctionParameter, ...ts.Expression[]];
      } {
        if (ts.isNewExpression(node)) {
          return (
            isFunctionlessClassOfKind(node, StepFunction.FunctionlessType) ||
            isFunctionlessClassOfKind(
              node,
              ExpressStepFunction.FunctionlessType
            )
          );
        }
        return false;
      }

      /**
       * Various types that could be in a call argument position of a function parameter.
       */
      type TsFunctionParameter =
        | ts.FunctionExpression
        | ts.ArrowFunction
        | ts.Identifier
        | ts.PropertyAccessExpression
        | ts.ElementAccessExpression
        | ts.CallExpression;

      type EventBusRuleInterface = ts.NewExpression & {
        arguments: [
          ts.Expression,
          ts.Expression,
          ts.Expression,
          TsFunctionParameter
        ];
      };

      type EventBusTransformInterface = ts.NewExpression & {
        arguments: [TsFunctionParameter, ts.Expression];
      };

      type EventBusWhenInterface = ts.CallExpression & {
        arguments: [ts.Expression, ts.Expression, TsFunctionParameter];
      };

      type EventBusMapInterface = ts.CallExpression & {
        arguments: [TsFunctionParameter];
      };

      type FunctionInterface = ts.NewExpression & {
        arguments: [
          ts.Expression,
          ts.Expression,
          TsFunctionParameter,
          ts.Expression | undefined
        ];
      };

      /**
       * Matches the patterns:
       *   * new EventBusRule()
       */
      function isNewEventBusRule(node: ts.Node): node is EventBusRuleInterface {
        return ts.isNewExpression(node) && isEventBusRule(node.expression);
      }

      /**
       * Matches the patterns:
       *   * new EventBusTransform()
       */
      function isNewEventBusTransform(
        node: ts.Node
      ): node is EventBusTransformInterface {
        return ts.isNewExpression(node) && isEventBusTransform(node.expression);
      }

      /**
       * Matches the patterns:
       *   * IEventBus.when
       *   * IEventBusRule.when
       */
      function isEventBusWhenFunction(
        node: ts.Node
      ): node is EventBusWhenInterface {
        return (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "when" &&
          (isEventBus(node.expression.expression) ||
            isEventBusRule(node.expression.expression))
        );
      }

      /**
       * Matches the patterns:
       *   * IEventBusRule.map()
       */
      function isEventBusRuleMapFunction(
        node: ts.Node
      ): node is EventBusMapInterface {
        return (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "map" &&
          isEventBusRule(node.expression.expression)
        );
      }

      function isEventBusPutCall(node: ts.Node): node is ts.CallExpression {
        return ts.isCallExpression(node) && isEventBus(node.expression);
      }

      function isFunctionCall(node: ts.Node): node is ts.CallExpression {
        return ts.isCallExpression(node) && isFunction(node.expression);
      }

      function isFunction(node: ts.Node) {
        return isFunctionlessClassOfKind(node, Function.FunctionlessType);
      }

      /**
       * Checks to see if a node is of type EventBus.
       * The node could be any kind of node that returns an event bus rule.
       *
       * Matches the patterns:
       *   * IEventBus
       */
      function isEventBus(node: ts.Node) {
        return isFunctionlessClassOfKind(node, EventBus.FunctionlessType);
      }

      /**
       * Checks to see if a node is of type {@link EventBusRule}.
       * The node could be any kind of node that returns an event bus rule.
       *
       * Matches the patterns:
       *   * IEventBusRule
       */
      function isEventBusRule(node: ts.Node) {
        return isFunctionlessClassOfKind(node, EventBusRule.FunctionlessType);
      }

      /**
       * Checks to see if a node is of type {@link EventBusTransform}.
       * The node could be any kind of node that returns an event bus rule.
       *
       * Matches the patterns:
       *   * IEventBusTransform
       */
      function isEventBusTransform(node: ts.Node) {
        return isFunctionlessClassOfKind(
          node,
          EventBusTransform.FunctionlessType
        );
      }

      function isNewFunctionlessFunction(
        node: ts.Node
      ): node is FunctionInterface {
        return (
          ts.isNewExpression(node) &&
          isFunctionlessClassOfKind(
            node.expression,
            Function.FunctionlessType
          ) &&
          // only take the form with the arrow function at the end.
          (node.arguments?.length === 3 || node.arguments?.length === 4) &&
          ts.isArrowFunction(node.arguments[2])
        );
      }

      // function isCDKConstruct(type: ts.Type): boolean {
      //   const constructImport = imports["constructs"];
      //   const constructSymbol = constructImport
      //     ? checker.getSymbolAtLocation(constructImport.moduleSpecifier)
      //     : undefined;
      //   const constructExports = constructSymbol
      //     ? checker.getExportsOfModule(constructSymbol)
      //     : undefined;
      //   const constructExportSymbol = constructExports?.find(
      //     (s) => s.name === "Construct"
      //   );

      //   return (
      //     (!constructExportSymbol ||
      //       type.symbol === constructExportSymbol ||
      //       type.getBaseTypes()?.some((t) => isCDKConstruct(t))) ??
      //     false
      //   );
      // }

      /**
       * Catches any errors and wraps them in a {@link Err} node.
       */
      function errorBoundary<T extends ts.Node>(
        func: () => T
      ): T | ts.NewExpression {
        try {
          return func();
        } catch (err) {
          const error =
            err instanceof Error ? err : Error("Unknown compiler error.");
          return newExpr("Err", [
            ts.factory.createNewExpression(
              ts.factory.createIdentifier(error.name),
              undefined,
              [ts.factory.createStringLiteral(error.message)]
            ),
          ]);
        }
      }

      /**
       * Checks if the type contains one of
       * a static property FunctionlessType with the value of {@param kind}
       * a property signature functionlessKind with literal type with the value of {@param kind}
       * a readonly property functionlessKind with literal type with the value of {@param kind}
       */
      function isFunctionlessType(
        type: ts.Type | undefined,
        kind: string
      ): boolean {
        return !!type && getFunctionlessTypeKind(type) === kind;
      }

      function isFunctionlessClassOfKind(node: ts.Node, kind: string) {
        const type = checker.getTypeAtLocation(node);
        return isFunctionlessType(type, kind);
      }

      function getFunctionlessTypeKind(type: ts.Type): string | undefined {
        const functionlessType = type.getProperty("FunctionlessType");
        const functionlessKind = type.getProperty("functionlessKind");
        const prop = functionlessType ?? functionlessKind;

        if (prop && prop.valueDeclaration) {
          if (
            ts.isPropertyDeclaration(prop.valueDeclaration) &&
            prop.valueDeclaration.initializer &&
            ts.isStringLiteral(prop.valueDeclaration.initializer)
          ) {
            return prop.valueDeclaration.initializer.text;
          } else if (ts.isPropertySignature(prop.valueDeclaration)) {
            const type = checker.getTypeAtLocation(prop.valueDeclaration);
            if (type.isStringLiteral()) {
              return type.value;
            }
          }
        }
        return undefined;
      }

      function visitStepFunction(call: ts.NewExpression): ts.Node {
        return ts.factory.updateNewExpression(
          call,
          call.expression,
          call.typeArguments,
          call.arguments?.map((arg) =>
            ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)
              ? errorBoundary(() => toFunction("FunctionDecl", arg))
              : arg
          )
        );
      }

      function visitEventBusRule(call: EventBusRuleInterface): ts.Node {
        const [one, two, three, impl] = call.arguments;

        return ts.factory.updateNewExpression(
          call,
          call.expression,
          call.typeArguments,
          [
            one,
            two,
            three,
            errorBoundary(() => toFunction("FunctionDecl", impl)),
          ]
        );
      }

      function visitEventTransform(call: EventBusTransformInterface): ts.Node {
        const [impl, ...rest] = call.arguments;

        return ts.factory.updateNewExpression(
          call,
          call.expression,
          call.typeArguments,
          [errorBoundary(() => toFunction("FunctionDecl", impl)), ...rest]
        );
      }

      function visitEventBusWhen(call: EventBusWhenInterface): ts.Node {
        const [one, two, impl] = call.arguments;

        return ts.factory.updateCallExpression(
          call,
          call.expression,
          call.typeArguments,
          [one, two, errorBoundary(() => toFunction("FunctionDecl", impl))]
        );
      }

      function visitEventBusMap(call: EventBusMapInterface): ts.Node {
        const [impl] = call.arguments;

        return ts.factory.updateCallExpression(
          call,
          call.expression,
          call.typeArguments,
          [errorBoundary(() => toFunction("FunctionDecl", impl))]
        );
      }

      function visitAppsyncResolver(call: ts.NewExpression): ts.Node {
        if (call.arguments?.length === 1) {
          const impl = call.arguments[0];
          if (ts.isFunctionExpression(impl) || ts.isArrowFunction(impl)) {
            return ts.factory.updateNewExpression(
              call,
              call.expression,
              call.typeArguments,
              [errorBoundary(() => toFunction("FunctionDecl", impl, 1))]
            );
          }
        }
        return call;
      }

      function visitFunction(
        func: FunctionInterface,
        context: ts.TransformationContext
      ): ts.Node {
        const [_one, _two, funcDecl, _four] = func.arguments;

        return ts.factory.updateNewExpression(
          func,
          func.expression,
          func.typeArguments,
          [
            _one,
            _two,
            errorBoundary(() => toNativeFunction(funcDecl, context)),
            ...(_four ? [_four] : []),
          ]
        );
      }

      interface NativeExprContext {
        preWarmContext: ts.Identifier;
        registerIntegration: (node: ts.Expression) => void;
      }

      /**
       * const functionless_eventBusClient = new EventBridge();
       * const MY_BUS = process.env["MY_BUS"];
       * export const handler = async () => {
       *  const events = events;
       *  await functionless_eventBusClient.putEvents(events.map(event => ({ EventBusArn: MY_BUS, ... })));
       * }
       */

      /**
       * const bus = new bus();
       * new Function(this, '', async () => {
       *  const functionless_eventBusClient = new EventBridge();
       *  const events = events;
       *  await functionless_eventBusClient.putEvents(events.map(event => ({ EventBusArn: bus.eventBusArn, ... })));
       * });
       */
      // class NativeContext {
      //   getClientFor(type: "EventBridge", id: ts.Identifier): { clientId: ts.Identifier, resourceId: ts.Expression } {
      //     return {
      //       clientId: ts.factory.createIdentifier("functionless_eb"),
      //       resourceId: ts.factory.createPropertyAccessExpression(id, "eventBusArn")
      //     }
      //   }
      // }

      /**
       * Native Functions do not allow the creation of resources, CDK constructs or functionless.
       */
      function toNativeFunction(
        impl: TsFunctionParameter,
        context: ts.TransformationContext
      ): ts.NewExpression {
        if (
          !ts.isFunctionDeclaration(impl) &&
          !ts.isArrowFunction(impl) &&
          !ts.isFunctionExpression(impl)
        ) {
          throw new Error(
            `Functionless reflection only supports function parameters with bodies, no signature only declarations or references. Found ${impl.getText()}.`
          );
        }

        if (impl.body === undefined) {
          throw new Error(
            `cannot parse declaration-only function: ${impl.getText()}`
          );
        }

        const integrations: ts.Expression[] = [];

        const preWarmContext =
          context.factory.createUniqueName("preWarmContext");

        const nativeExprContext: NativeExprContext = {
          preWarmContext,
          registerIntegration: (integ) => integrations.push(integ),
        };

        const body = toNativeExpr(
          impl.body,
          context,
          nativeExprContext
        ) as ts.ConciseBody;

        const closure = ts.factory.createArrowFunction(
          impl.modifiers,
          impl.typeParameters,
          impl.parameters,
          impl.type,
          undefined,
          body
        );

        return newExpr("NativeFunctionDecl", [
          ts.factory.createArrayLiteralExpression(
            impl.parameters
              .map((param) => param.name.getText())
              .map((arg) =>
                newExpr("ParameterDecl", [ts.factory.createStringLiteral(arg)])
              )
          ),
          // (prewarmContext) => closure;
          context.factory.createArrowFunction(
            undefined,
            undefined,
            [
              context.factory.createParameterDeclaration(
                undefined,
                undefined,
                undefined,
                preWarmContext,
                undefined,
                undefined,
                undefined
              ),
            ],
            undefined,
            undefined,
            closure
          ),
          context.factory.createArrayLiteralExpression(integrations),
        ]);
      }

      function toNativeExpr(
        node: ts.Node,
        context: ts.TransformationContext,
        nativeExprContext: NativeExprContext
      ): ts.Node | ts.Node[] | undefined {
        if (isEventBusPutCall(node)) {
          // add client
          // get bus arn as env variable
          // create client call that uses the env variable and the parameters
          /*
            in: bus(event1, event2)
            out: (await eventBridgeClient.PutEvents({
              Entries: [
                {
                  EventBusName: bus.bus.eventBusArn,
                  Source: event1.source,
                  DetailType: event1["detail-type"],
                  Detail: JSON.parse(event1.detail)
                }
              ]
              FunctionName: func.resource.functionName,
              Payload: payload
            }).promise()).Payload
            */
          return context.factory.createIdentifier("thisisbus");
        } else if (isFunctionCall(node)) {
          // add the function identifier to the integrations
          nativeExprContext.registerIntegration(node.expression);
          // call the integration call function with the prewarm context and arguments
          // At this point, we know native will not be undefined
          // await integration.native.call(args, preWarmContext)
          // FIXME: doesn't work without an array
          // TODO: Support both sync and async function invocations: https://github.com/sam-goodwin/functionless/issues/105
          return [
            context.factory.createAwaitExpression(
              context.factory.createCallExpression(
                context.factory.createPropertyAccessExpression(
                  context.factory.createPropertyAccessExpression(
                    node.expression,
                    "native"
                  ),
                  "call"
                ),
                undefined,
                [
                  context.factory.createArrayLiteralExpression(node.arguments),
                  // TODO: determine if this is needed at all?
                  nativeExprContext.preWarmContext,
                ]
              )
            ),
          ];
          // const client = context.factory.createUniqueName("lambda");
          // return [
          //   context.factory.createVariableStatement(undefined, [
          //     context.factory.createVariableDeclaration(
          //       client,
          //       undefined,
          //       undefined,
          //       context.factory.createNewExpression(
          //         context.factory.createPropertyAccessExpression(
          //           awsClient,
          //           "Lambda"
          //         ),
          //         undefined,
          //         []
          //       )
          //     ),
          //   ]),
          //   /*
          //   in: func(payload)
          //   out: (await lambdaClient.invoke({
          //     FunctionName: func.resource.functionName,
          //     Payload: payload
          //   }).promise()).Payload
          //   */
          //   context.factory.createPropertyAccessExpression(
          //     context.factory.createAwaitExpression(
          //       context.factory.createCallExpression(
          //         context.factory.createPropertyAccessExpression(
          //           context.factory.createCallExpression(
          //             context.factory.createPropertyAccessExpression(
          //               client,
          //               "invoke"
          //             ),
          //             undefined,
          //             [
          //               context.factory.createObjectLiteralExpression([
          //                 context.factory.createPropertyAssignment(
          //                   "FunctionName",
          //                   context.factory.createPropertyAccessExpression(
          //                     context.factory.createPropertyAccessExpression(
          //                       node.expression,
          //                       "resource"
          //                     ),
          //                     "functionName"
          //                   )
          //                 ),
          //                 ...(node.arguments.length > 0
          //                   ? [
          //                       context.factory.createPropertyAssignment(
          //                         "Payload",
          //                         node.arguments[0]
          //                       ),
          //                     ]
          //                   : []),
          //               ]),
          //             ]
          //           ),
          //           "promise"
          //         ),
          //         undefined,
          //         undefined
          //       )
          //     ),
          //     "Payload"
          //   ),
          // ];
        } else if (ts.isNewExpression(node)) {
          const newType = checker.getTypeAtLocation(node);
          // cannot create new resources in native runtime code.
          const functionlessKind = getFunctionlessTypeKind(newType);
          if (getFunctionlessTypeKind(newType)) {
            throw Error(
              `Cannot initialize new resources in a native function, found ${functionlessKind}.`
            );
          }
          // TODO: check for CDK constructs
          // const type = checker.getTypeAtLocation(node.expression);
          // if (isCDKConstruct(type)) {
          //   throw Error(
          //     `Cannot initialize new resources in a native function, found ${type.symbol.name}.`
          //   );
          // }
        } else if (ts.isReturnStatement(node)) {
          const child = node.expression
            ? toNativeExpr(node.expression, context, nativeExprContext)
            : undefined;
          if (!child) {
            return node;
          } else if (Array.isArray(child)) {
            // if multiple nodes are returned, assume the last one is the value to assign and the rest should be injected as siblings.
            const [last, ...rest] = child.reverse();
            return [
              ...rest.reverse(),
              context.factory.updateReturnStatement(
                node,
                last as ts.Expression
              ),
            ];
          } else {
            return context.factory.updateReturnStatement(
              node,
              child as ts.Expression
            );
          }
        } else if (ts.isVariableDeclarationList(node)) {
          // bubble any extra nodes to the top of the variable declaration list.
          const [extra, declarations] = node.declarations.reduce(
            ([extra, declarations], decl) => {
              const values = toNativeExpr(decl, context, nativeExprContext);
              if (!values) {
                return [extra, declarations];
              } else if (Array.isArray(values)) {
                const [decl, ...ext] = values.reverse();
                return [
                  [...extra, ...ext],
                  [...declarations, decl as ts.VariableDeclaration],
                ];
              } else {
                return [
                  extra,
                  [...declarations, decl as ts.VariableDeclaration],
                ];
              }
            },
            [[], []] as [ts.Node[], ts.VariableDeclaration[]]
          );

          return [
            ...extra,
            context.factory.updateVariableDeclarationList(node, declarations),
          ];
        } else if (ts.isVariableDeclaration(node)) {
          const child = node.initializer
            ? toNativeExpr(node.initializer, context, nativeExprContext)
            : undefined;
          if (!child) {
            return node;
          } else if (Array.isArray(child)) {
            const newDecl = context.factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type,
              child.length > 0
                ? (child[child.length - 1] as ts.Expression)
                : undefined
            );
            return [
              ...(child.length > 1 ? child.slice(0, child.length - 1) : []),
              newDecl,
            ];
          } else {
            return context.factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type,
              child as ts.Expression
            );
          }
        } else if (ts.isVariableStatement(node)) {
          const decls = toNativeExpr(
            node.declarationList,
            context,
            nativeExprContext
          );
          if (!decls) {
            return node;
          } else if (Array.isArray(decls)) {
            const [decl, ...extra] = decls.reverse();
            return [
              ...extra.reverse(),
              context.factory.updateVariableStatement(
                node,
                node.modifiers,
                decl as ts.VariableDeclarationList
              ),
            ];
          } else {
            return context.factory.updateVariableStatement(
              node,
              node.modifiers,
              decls as ts.VariableDeclarationList
            );
          }
        }

        // let everything else fall through, process their children too
        return ts.visitEachChild(
          node,
          (node) => toNativeExpr(node, context, nativeExprContext),
          context
        );
      }

      function toFunction(
        type: "FunctionDecl" | "FunctionExpr",
        impl: TsFunctionParameter,
        dropArgs?: number
      ): ts.Expression {
        if (
          !ts.isFunctionDeclaration(impl) &&
          !ts.isArrowFunction(impl) &&
          !ts.isFunctionExpression(impl)
        ) {
          throw new Error(
            `Functionless reflection only supports function parameters with bodies, no signature only declarations or references. Found ${impl.getText()}.`
          );
        }

        const params =
          dropArgs === undefined
            ? impl.parameters
            : impl.parameters.slice(dropArgs);

        if (impl.body === undefined) {
          throw new Error(
            `cannot parse declaration-only function: ${impl.getText()}`
          );
        }
        const body = ts.isBlock(impl.body)
          ? toExpr(impl.body, impl)
          : newExpr("BlockStmt", [
              ts.factory.createArrayLiteralExpression([
                newExpr("ReturnStmt", [toExpr(impl.body, impl)]),
              ]),
            ]);

        return newExpr(type, [
          ts.factory.createArrayLiteralExpression(
            params
              .map((param) => param.name.getText())
              .map((arg) =>
                newExpr("ParameterDecl", [ts.factory.createStringLiteral(arg)])
              )
          ),
          body,
        ]);
      }

      function toExpr(
        node: ts.Node | undefined,
        scope: ts.Node
      ): ts.Expression {
        if (node === undefined) {
          return ts.factory.createIdentifier("undefined");
        } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          return toFunction("FunctionExpr", node);
        } else if (ts.isExpressionStatement(node)) {
          return newExpr("ExprStmt", [toExpr(node.expression, scope)]);
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const exprType = checker.getTypeAtLocation(node.expression);
          const functionBrand = exprType.getProperty("__functionBrand");
          let signature: ts.Signature | undefined;
          if (functionBrand !== undefined) {
            const functionType = checker.getTypeOfSymbolAtLocation(
              functionBrand,
              node.expression
            );
            const signatures = checker.getSignaturesOfType(
              functionType,
              ts.SignatureKind.Call
            );

            if (signatures.length === 1) {
              signature = signatures[0];
            } else {
              throw new Error(
                `Lambda Functions with multiple signatures are not currently supported.`
              );
            }
          } else {
            signature = checker.getResolvedSignature(node);
          }
          if (signature && signature.parameters.length > 0) {
            return newExpr(ts.isCallExpression(node) ? "CallExpr" : "NewExpr", [
              toExpr(node.expression, scope),
              ts.factory.createArrayLiteralExpression(
                signature.parameters.map((parameter, i) =>
                  newExpr("Argument", [
                    (parameter.declarations?.[0] as ts.ParameterDeclaration)
                      ?.dotDotDotToken
                      ? newExpr("ArrayLiteralExpr", [
                          ts.factory.createArrayLiteralExpression(
                            node.arguments
                              ?.slice(i)
                              .map((x) => toExpr(x, scope)) ?? []
                          ),
                        ])
                      : toExpr(node.arguments?.[i], scope),
                    ts.factory.createStringLiteral(parameter.name),
                  ])
                )
              ),
            ]);
          } else {
            return newExpr("CallExpr", [
              toExpr(node.expression, scope),
              ts.factory.createArrayLiteralExpression(
                node.arguments?.map((arg) =>
                  newExpr("Argument", [
                    toExpr(arg, scope),
                    ts.factory.createIdentifier("undefined"),
                  ])
                ) ?? []
              ),
            ]);
          }
        } else if (ts.isBlock(node)) {
          return newExpr("BlockStmt", [
            ts.factory.createArrayLiteralExpression(
              node.statements.map((x) => toExpr(x, scope))
            ),
          ]);
        } else if (ts.isIdentifier(node)) {
          if (node.text === "undefined") {
            return newExpr("UndefinedLiteralExpr", []);
          } else if (node.text === "null") {
            return newExpr("NullLiteralExpr", []);
          }
          const kind = getKind(node);
          if (kind !== undefined) {
            // if this is a reference to a Table or Lambda, retain it
            return ref(node);
          }

          const symbol = checker.getSymbolAtLocation(node);
          /**
           * If the identifier is not within the closure, we attempt to enclose the reference in its own closure.
           * const val = "hello";
           * reflect(() => return { value: val }; );
           *
           * result
           *
           * return { value: () => val };
           */
          if (symbol) {
            const ref = outOfScopeIdentifierToRef(symbol, scope);
            if (ref) {
              return ref;
            }
          }

          return newExpr("Identifier", [
            ts.factory.createStringLiteral(node.text),
          ]);
        } else if (ts.isPropertyAccessExpression(node)) {
          const kind = getKind(node);
          if (kind !== undefined) {
            // if this is a reference to a Table or Lambda, retain it
            return ref(node);
          }
          const type = checker.getTypeAtLocation(node.name);
          return newExpr("PropAccessExpr", [
            toExpr(node.expression, scope),
            ts.factory.createStringLiteral(node.name.text),
            type
              ? ts.factory.createStringLiteral(checker.typeToString(type))
              : ts.factory.createIdentifier("undefined"),
          ]);
        } else if (ts.isElementAccessExpression(node)) {
          const type = checker.getTypeAtLocation(node.argumentExpression);
          return newExpr("ElementAccessExpr", [
            toExpr(node.expression, scope),
            toExpr(node.argumentExpression, scope),
            type
              ? ts.factory.createStringLiteral(checker.typeToString(type))
              : ts.factory.createIdentifier("undefined"),
          ]);
        } else if (
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.length === 1
        ) {
          return toExpr(node.declarationList.declarations[0], scope);
        } else if (ts.isVariableDeclaration(node)) {
          return newExpr("VariableStmt", [
            ts.factory.createStringLiteral(node.name.getText()),
            ...(node.initializer ? [toExpr(node.initializer, scope)] : []),
          ]);
        } else if (ts.isIfStatement(node)) {
          return newExpr("IfStmt", [
            // when
            toExpr(node.expression, scope),
            // then
            toExpr(node.thenStatement, scope),
            // else
            ...(node.elseStatement ? [toExpr(node.elseStatement, scope)] : []),
          ]);
        } else if (ts.isConditionalExpression(node)) {
          return newExpr("ConditionExpr", [
            // when
            toExpr(node.condition, scope),
            // then
            toExpr(node.whenTrue, scope),
            // else
            toExpr(node.whenFalse, scope),
          ]);
        } else if (ts.isBinaryExpression(node)) {
          const op = getOperator(node.operatorToken);
          if (op === undefined) {
            throw new Error(
              `invalid Binary Operator: ${node.operatorToken.getText()}`
            );
          }
          return newExpr("BinaryExpr", [
            toExpr(node.left, scope),
            ts.factory.createStringLiteral(op),
            toExpr(node.right, scope),
          ]);
        } else if (ts.isPrefixUnaryExpression(node)) {
          if (
            node.operator !== ts.SyntaxKind.ExclamationToken &&
            node.operator !== ts.SyntaxKind.MinusToken
          ) {
            throw new Error(
              `invalid Unary Operator: ${ts.tokenToString(node.operator)}`
            );
          }
          return newExpr("UnaryExpr", [
            ts.factory.createStringLiteral(
              assertDefined(
                ts.tokenToString(node.operator),
                `Unary operator token cannot be stringified: ${node.operator}`
              )
            ),
            toExpr(node.operand, scope),
          ]);
        } else if (ts.isReturnStatement(node)) {
          return newExpr(
            "ReturnStmt",
            node.expression
              ? [toExpr(node.expression, scope)]
              : [newExpr("NullLiteralExpr", [])]
          );
        } else if (ts.isObjectLiteralExpression(node)) {
          return newExpr("ObjectLiteralExpr", [
            ts.factory.createArrayLiteralExpression(
              node.properties.map((x) => toExpr(x, scope))
            ),
          ]);
        } else if (ts.isPropertyAssignment(node)) {
          return newExpr("PropAssignExpr", [
            ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)
              ? string(node.name.text)
              : toExpr(node.name, scope),
            toExpr(node.initializer, scope),
          ]);
        } else if (ts.isComputedPropertyName(node)) {
          return newExpr("ComputedPropertyNameExpr", [
            toExpr(node.expression, scope),
          ]);
        } else if (ts.isShorthandPropertyAssignment(node)) {
          return newExpr("PropAssignExpr", [
            newExpr("Identifier", [
              ts.factory.createStringLiteral(node.name.text),
            ]),
            toExpr(node.name, scope),
          ]);
        } else if (ts.isSpreadAssignment(node)) {
          return newExpr("SpreadAssignExpr", [toExpr(node.expression, scope)]);
        } else if (ts.isSpreadElement(node)) {
          return newExpr("SpreadElementExpr", [toExpr(node.expression, scope)]);
        } else if (ts.isArrayLiteralExpression(node)) {
          return newExpr("ArrayLiteralExpr", [
            ts.factory.updateArrayLiteralExpression(
              node,
              node.elements.map((x) => toExpr(x, scope))
            ),
          ]);
        } else if (node.kind === ts.SyntaxKind.NullKeyword) {
          return newExpr("NullLiteralExpr", [
            ts.factory.createIdentifier("false"),
          ]);
        } else if (ts.isNumericLiteral(node)) {
          return newExpr("NumberLiteralExpr", [node]);
        } else if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)
        ) {
          return newExpr("StringLiteralExpr", [node]);
        } else if (ts.isLiteralExpression(node)) {
          // const type = checker.getTypeAtLocation(node);
          // if (type.symbol.escapedName === "boolean") {
          //   return newExpr("BooleanLiteralExpr", [node]);
          // }
        } else if (
          node.kind === ts.SyntaxKind.TrueKeyword ||
          node.kind === ts.SyntaxKind.FalseKeyword
        ) {
          return newExpr("BooleanLiteralExpr", [node as ts.Expression]);
        } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
          if (ts.isVariableDeclarationList(node.initializer)) {
            if (node.initializer.declarations.length === 1) {
              const varDecl = node.initializer.declarations[0];
              if (ts.isIdentifier(varDecl.name)) {
                // for (const i in list)
                return newExpr(
                  ts.isForOfStatement(node) ? "ForOfStmt" : "ForInStmt",
                  [
                    toExpr(varDecl, scope),
                    toExpr(node.expression, scope),
                    toExpr(node.statement, scope),
                  ]
                );
              } else if (ts.isArrayBindingPattern(varDecl.name)) {
                // for (const [a, b] in list)
              }
            }
          }
        } else if (ts.isTemplateExpression(node)) {
          const exprs = [];
          if (node.head.text) {
            exprs.push(string(node.head.text));
          }
          for (const span of node.templateSpans) {
            exprs.push(toExpr(span.expression, scope));
            if (span.literal.text) {
              exprs.push(string(span.literal.text));
            }
          }
          return newExpr("TemplateExpr", [
            ts.factory.createArrayLiteralExpression(exprs),
          ]);
        } else if (ts.isBreakStatement(node)) {
          return newExpr("BreakStmt", []);
        } else if (ts.isContinueStatement(node)) {
          return newExpr("ContinueStmt", []);
        } else if (ts.isTryStatement(node)) {
          return newExpr("TryStmt", [
            toExpr(node.tryBlock, scope),
            node.catchClause
              ? toExpr(node.catchClause, scope)
              : ts.factory.createIdentifier("undefined"),
            node.finallyBlock
              ? toExpr(node.finallyBlock, scope)
              : ts.factory.createIdentifier("undefined"),
          ]);
        } else if (ts.isCatchClause(node)) {
          return newExpr("CatchClause", [
            node.variableDeclaration
              ? toExpr(node.variableDeclaration, scope)
              : ts.factory.createIdentifier("undefined"),
            toExpr(node.block, scope),
          ]);
        } else if (ts.isThrowStatement(node)) {
          return newExpr("ThrowStmt", [toExpr(node.expression, scope)]);
        } else if (ts.isTypeOfExpression(node)) {
          return newExpr("TypeOfExpr", [toExpr(node.expression, scope)]);
        } else if (ts.isWhileStatement(node)) {
          return newExpr("WhileStmt", [
            toExpr(node.expression, scope),
            ts.isBlock(node.statement)
              ? toExpr(node.statement, scope)
              : // re-write a standalone statement as as BlockStmt
                newExpr("BlockStmt", [
                  ts.factory.createArrayLiteralExpression([
                    toExpr(node.statement, scope),
                  ]),
                ]),
          ]);
        } else if (ts.isDoStatement(node)) {
          return newExpr("DoStmt", [
            ts.isBlock(node.statement)
              ? toExpr(node.statement, scope)
              : // re-write a standalone statement as as BlockStmt
                newExpr("BlockStmt", [
                  ts.factory.createArrayLiteralExpression([
                    toExpr(node.statement, scope),
                  ]),
                ]),
            toExpr(node.expression, scope),
          ]);
        } else if (ts.isParenthesizedExpression(node)) {
          return toExpr(node.expression, scope);
        } else if (ts.isAsExpression(node)) {
          return toExpr(node.expression, scope);
        } else if (ts.isTypeAssertionExpression(node)) {
          return toExpr(node.expression, scope);
        } else if (ts.isNonNullExpression(node)) {
          return toExpr(node.expression, scope);
        } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
          // assuming that this is used in a valid location, create a closure around that instance.
          return ref(ts.factory.createIdentifier("this"));
        }

        throw new Error(
          `unhandled node: ${node.getText()} ${ts.SyntaxKind[node.kind]}`
        );
      }

      function ref(node: ts.Expression) {
        return newExpr("ReferenceExpr", [
          ts.factory.createStringLiteral(exprToString(node)),
          ts.factory.createArrowFunction(
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            node
          ),
        ]);
      }

      /**
       * Follow the parent of the symbol to determine if the identifier shares the same scope as the current closure being compiled.
       * If not within the scope of the current closure, return a reference that returns the external value if possible.
       * const val = "hello";
       * reflect(() => return { value: val }; );
       *
       * result
       *
       * return { value: () => val };
       */
      function outOfScopeIdentifierToRef(
        symbol: ts.Symbol,
        scope: ts.Node
      ): ts.NewExpression | undefined {
        if (symbol) {
          if (symbol.valueDeclaration) {
            // Identifies if Shorthand Property Assignment value declarations return the shorthand prop assignment and not the value.
            // const value = "hello"
            // const v = { value } <== shorthand prop assignment.
            // The checker supports getting the value assignment symbol, recursively call this method on the new symbol instead.
            if (ts.isShorthandPropertyAssignment(symbol.valueDeclaration)) {
              const updatedSymbol = checker.getShorthandAssignmentValueSymbol(
                symbol.valueDeclaration
              );
              return updatedSymbol
                ? outOfScopeIdentifierToRef(updatedSymbol, scope)
                : undefined;
            } else if (ts.isVariableDeclaration(symbol.valueDeclaration)) {
              if (
                symbol.valueDeclaration.initializer &&
                !hasParent(symbol.valueDeclaration, scope)
              ) {
                return ref(ts.factory.createIdentifier(symbol.name));
              }
            }
          }
        }
        return;
      }

      function exprToString(node: ts.Expression): string {
        if (ts.isIdentifier(node)) {
          return node.text;
        } else if (ts.isPropertyAccessExpression(node)) {
          return `${exprToString(node.expression)}.${exprToString(node.name)}`;
        } else if (ts.isElementAccessExpression(node)) {
          return `${exprToString(node.expression)}[${exprToString(
            node.argumentExpression
          )}]`;
        } else {
          return "";
        }
      }

      function string(literal: string): ts.Expression {
        return newExpr("StringLiteralExpr", [
          ts.factory.createStringLiteral(literal),
        ]);
      }

      function newExpr(type: FunctionlessNode["kind"], args: ts.Expression[]) {
        return ts.factory.createNewExpression(
          ts.factory.createPropertyAccessExpression(functionless, type),
          undefined,
          args
        );
      }

      function getKind(
        node: ts.Node
      ): Extract<CanReference, "kind"> | undefined {
        const exprType = checker.getTypeAtLocation(node);
        const exprKind = exprType.getProperty("kind");
        if (exprKind) {
          const exprKindType = checker.getTypeOfSymbolAtLocation(
            exprKind,
            node
          );
          if (exprKindType.isStringLiteral()) {
            return exprKindType.value as any;
          }
        }
        return undefined;
      }
    };
  };
}

function getOperator(op: ts.BinaryOperatorToken): BinaryOp | undefined {
  return OperatorMappings[op.kind as keyof typeof OperatorMappings];
}

const OperatorMappings: Record<number, BinaryOp> = {
  [ts.SyntaxKind.EqualsToken]: "=",
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "==",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
  [ts.SyntaxKind.InKeyword]: "in",
} as const;

// const isTsStatement = (node: ts.Node): node is ts.Statement =>
//   "_statementBrand" in node;

// const isTsExpression = (node: ts.Node): node is ts.Expression =>
//   "_expressionBrand" in node;

// const isTsDeclaration = (node: ts.Node): node is ts.Declaration =>
//   "_declarationBrand" in node;
