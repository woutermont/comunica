import { BindingsFactory } from '@comunica/bindings-factory';
import type { Bindings } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string';
import type { Algebra, Factory } from 'sparqlalgebrajs';
import { Util } from 'sparqlalgebrajs';

const BF = new BindingsFactory();

/**
 * Materialize a term with the given binding.
 *
 * If the given term is a variable,
 * and that variable exist in the given bindings object,
 * the value of that binding is returned.
 * In all other cases, the term itself is returned.
 *
 * @param {RDF.Term} term A term.
 * @param {Bindings} bindings A bindings object.
 * @return {RDF.Term} The materialized term.
 */
export function materializeTerm(term: RDF.Term, bindings: Bindings): RDF.Term {
  if (term.termType === 'Variable') {
    const value = bindings.get(term);
    if (value) {
      return value;
    }
  }
  return term;
}

/**
 * Materialize the given operation (recursively) with the given bindings.
 * Essentially, all variables in the given operation will be replaced
 * by the terms bound to the variables in the given bindings.
 * @param {Operation} operation SPARQL algebra operation.
 * @param {Bindings} bindings A bindings object.
 * @param options Options for materializations.
 * @return Algebra.Operation A new operation materialized with the given bindings.
 */
export function materializeOperation(
  operation: Algebra.Operation,
  bindings: Bindings,
  options: {
    /**
     * If target variable bindings (such as on SELECT or BIND) should not be allowed.
     */
    strictTargetVariables?: boolean;
    /**
     * If filter expressions should be materialized
     */
    bindFilter?: boolean;
  } = {},
): Algebra.Operation {
  options = {
    strictTargetVariables: 'strictTargetVariables' in options ? options.strictTargetVariables : false,
    bindFilter: 'bindFilter' in options ? options.bindFilter : true,
  };

  return Util.mapOperation(operation, {
    path(op: Algebra.Path, factory: Factory) {
      // Materialize variables in a path expression.
      // The predicate expression will be recursed.
      return {
        recurse: false,
        result: factory.createPath(
          materializeTerm(op.subject, bindings),
          op.predicate,
          materializeTerm(op.object, bindings),
          materializeTerm(op.graph, bindings),
        ),
      };
    },
    pattern(op: Algebra.Pattern, factory: Factory) {
      // Materialize variables in the quad pattern.
      return {
        recurse: false,
        result: factory.createPattern(
          materializeTerm(op.subject, bindings),
          materializeTerm(op.predicate, bindings),
          materializeTerm(op.object, bindings),
          materializeTerm(op.graph, bindings),
        ),
      };
    },
    extend(op: Algebra.Extend) {
      // Materialize an extend operation.
      // If strictTargetVariables is true, we throw if the extension target variable is attempted to be bound.
      // Otherwise, we remove the extend operation.
      if (bindings.has(op.variable)) {
        if (options.strictTargetVariables) {
          throw new Error(`Tried to bind variable ${termToString(op.variable)} in a BIND operator.`);
        } else {
          return {
            recurse: true,
            result: materializeOperation(op.input, bindings, options),
          };
        }
      }
      return {
        recurse: true,
        result: op,
      };
    },
    group(op: Algebra.Group, factory: Factory) {
      // Materialize a group operation.
      // If strictTargetVariables is true, we throw if the group target variable is attempted to be bound.
      // Otherwise, we just filter out the bound variables.
      if (options.strictTargetVariables) {
        for (const variable of op.variables) {
          if (bindings.has(variable)) {
            throw new Error(`Tried to bind variable ${termToString(variable)} in a GROUP BY operator.`);
          }
        }
        return {
          recurse: true,
          result: op,
        };
      }
      const variables = op.variables.filter(variable => !bindings.has(variable));
      return {
        recurse: true,
        result: factory.createGroup(
          op.input,
          variables,
          op.aggregates,
        ),
      };
    },
    project(op: Algebra.Project, factory: Factory) {
      // Materialize a project operation.
      // If strictTargetVariables is true, we throw if the project target variable is attempted to be bound.
      // Otherwise, we just filter out the bound variables.
      if (options.strictTargetVariables) {
        for (const variable of op.variables) {
          if (bindings.has(variable)) {
            throw new Error(`Tried to bind variable ${termToString(variable)} in a SELECT operator.`);
          }
        }
        return {
          recurse: true,
          result: op,
        };
      }

      const variables = op.variables.filter(variable => !bindings.has(variable));

      // Only include projected variables in the sub-bindings that will be passed down recursively.
      // If we don't do this, we may be binding variables that may have the same label, but are not considered equal.
      const subBindings = BF.bindings(<[RDF.Variable, RDF.Term][]> op.variables.map(variable => {
        const binding = bindings.get(variable);
        if (binding) {
          return [ variable, binding ];
        }
        // eslint-disable-next-line no-useless-return
        return;
      }).filter(entry => Boolean(entry)));

      return {
        recurse: false,
        result: factory.createProject(
          materializeOperation(
            op.input,
            subBindings,
            options,
          ),
          variables,
        ),
      };
    },
    values(op: Algebra.Values, factory: Factory) {
      // Materialize a values operation.
      // If strictTargetVariables is true, we throw if the values target variable is attempted to be bound.
      // Otherwise, we just filter out the bound variables and their bindings.
      if (options.strictTargetVariables) {
        for (const variable of op.variables) {
          if (bindings.has(variable)) {
            throw new Error(`Tried to bind variable ${termToString(variable)} in a VALUES operator.`);
          }
        }
      } else {
        const variables = op.variables.filter(variable => !bindings.has(variable));
        const valueBindings: Record<string, RDF.Literal | RDF.NamedNode>[] = <any> op.bindings.map(binding => {
          const newBinding = { ...binding };
          let valid = true;
          bindings.forEach((value: RDF.NamedNode, key: RDF.Variable) => {
            const keyString = termToString(key);
            if (keyString in newBinding) {
              if (!value.equals(newBinding[keyString])) {
                // If the value of the binding is not equal, remove this binding completely from the VALUES clause
                valid = false;
              }
              delete newBinding[keyString];
            }
          });
          return valid ? newBinding : undefined;
        }).filter(Boolean);
        return {
          recurse: true,
          result: factory.createValues(
            variables,
            valueBindings,
          ),
        };
      }
      return {
        recurse: false,
        result: op,
      };
    },
    expression(op: Algebra.Expression, factory: Factory) {
      if (!options.bindFilter) {
        return {
          recurse: false,
          result: op,
        };
      }

      if (op.expressionType === 'term') {
        // Materialize a term expression
        return {
          recurse: false,
          result: factory.createTermExpression(materializeTerm(op.term, bindings)),
        };
      }
      if (op.expressionType === 'aggregate' &&
        'variable' in op &&
        bindings.has(<RDF.Variable> op.variable)) {
        // Materialize a bound aggregate operation.
        // If strictTargetVariables is true, we throw if the expression target variable is attempted to be bound.
        // Otherwise, we ignore this operation.
        if (options.strictTargetVariables) {
          throw new Error(`Tried to bind ${termToString(op.variable)} in a ${op.aggregator} aggregate.`);
        } else {
          return {
            recurse: true,
            result: op,
          };
        }
      }
      return {
        recurse: true,
        result: op,
      };
    },
  });
}
