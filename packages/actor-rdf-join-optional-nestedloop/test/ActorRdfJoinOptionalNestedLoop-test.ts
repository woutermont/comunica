import { Bindings } from '@comunica/bus-query-operation';
import type { IActionRdfJoin } from '@comunica/bus-rdf-join';
import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput } from '@comunica/bus-rdf-join-selectivity';
import type { Actor, IActorTest, Mediator } from '@comunica/core';
import { Bus } from '@comunica/core';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinOptionalNestedLoop } from '../lib/ActorRdfJoinOptionalNestedLoop';
const arrayifyStream = require('arrayify-stream');
const DF = new DataFactory();

describe('ActorRdfJoinOptionalNestedLoop', () => {
  let bus: any;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
  });

  describe('An ActorRdfJoinOptionalNestedLoop instance', () => {
    let mediatorJoinSelectivity: Mediator<
    Actor<IActionRdfJoinSelectivity, IActorTest, IActorRdfJoinSelectivityOutput>,
    IActionRdfJoinSelectivity, IActorTest, IActorRdfJoinSelectivityOutput>;
    let actor: ActorRdfJoinOptionalNestedLoop;

    beforeEach(() => {
      mediatorJoinSelectivity = <any> {
        mediate: async() => ({ selectivity: 1 }),
      };
      actor = new ActorRdfJoinOptionalNestedLoop({ name: 'actor', bus, mediatorJoinSelectivity });
    });

    describe('test', () => {
      it('should not test on zero entries', async() => {
        await expect(actor.test({
          type: 'optional',
          entries: [],
        })).rejects.toThrow('actor requires at least two join entries.');
      });

      it('should not test on one entry', async() => {
        await expect(actor.test({
          type: 'optional',
          entries: <any> [{}],
        })).rejects.toThrow('actor requires at least two join entries.');
      });

      it('should not test on three entries', async() => {
        await expect(actor.test({
          type: 'optional',
          entries: <any> [{}, {}, {}],
        })).rejects.toThrow('actor requires 2 join entries at most. The input contained 3.');
      });

      it('should not test on a non-optional operation', async() => {
        await expect(actor.test({
          type: 'inner',
          entries: <any> [{}, {}],
        })).rejects.toThrow(`actor can only handle logical joins of type 'optional', while 'inner' was given.`);
      });

      it('should test on two entries', async() => {
        expect(await actor.test({
          type: 'optional',
          entries: <any> [
            {
              output: {
                type: 'bindings',
                metadata: () => Promise.resolve({ cardinality: 4, pageSize: 100, requestTime: 10 }),
              },
            },
            {
              output: {
                type: 'bindings',
                metadata: () => Promise.resolve({ cardinality: 4, pageSize: 100, requestTime: 10 }),
              },
            },
          ],
        })).toEqual({
          iterations: 16,
          blockingItems: 0,
          persistedItems: 0,
          requestTime: 0.8,
        });
      });
    });

    describe('run', () => {
      it('should handle two entries', async() => {
        const action: IActionRdfJoin = {
          type: 'optional',
          entries: [
            {
              output: {
                bindingsStream: new ArrayIterator([
                  Bindings({ '?a': DF.literal('1') }),
                  Bindings({ '?a': DF.literal('2') }),
                  Bindings({ '?a': DF.literal('3') }),
                ], { autoStart: false }),
                metadata: () => Promise.resolve({ cardinality: 3, canContainUndefs: false }),
                type: 'bindings',
                variables: [ 'a' ],
              },
              operation: <any> {},
            },
            {
              output: {
                bindingsStream: new ArrayIterator([
                  Bindings({ '?a': DF.literal('1'), '?b': DF.literal('1') }),
                  Bindings({ '?a': DF.literal('3'), '?b': DF.literal('1') }),
                  Bindings({ '?a': DF.literal('3'), '?b': DF.literal('2') }),
                ], { autoStart: false }),
                metadata: () => Promise.resolve({ cardinality: 3, canContainUndefs: false }),
                type: 'bindings',
                variables: [ 'a', 'b' ],
              },
              operation: <any> {},
            },
          ],
        };
        const result = await actor.run(action);

        // Validate output
        expect(result.type).toEqual('bindings');
        expect(await result.metadata()).toEqual({ cardinality: 9, canContainUndefs: true });
        expect(await arrayifyStream(result.bindingsStream)).toEqual([
          Bindings({ '?a': DF.literal('1'), '?b': DF.literal('1') }),
          Bindings({ '?a': DF.literal('2') }),
          Bindings({ '?a': DF.literal('3'), '?b': DF.literal('1') }),
          Bindings({ '?a': DF.literal('3'), '?b': DF.literal('2') }),
        ]);
        expect(result.variables).toEqual([ 'a', 'b' ]);
      });
    });
  });
});
