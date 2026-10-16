import {
  createQuery,
  mutationOptions,
  MutationObserver,
  QueryClient,
  type CreateMutationOptions,
  type DataTag,
  type DefaultError,
  type DefinedCreateQueryResult,
  type MutateOptions,
  type NonUndefinedGuard,
  type QueryKey,
  type UndefinedInitialDataOptions,
} from '@tanstack/svelte-query';
import { noop } from 'lodash-es';
import { eventManager } from '$lib/managers/event-manager.svelte';

const createQueryClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  eventManager.on({ AuthLogout: () => client.clear() });

  return client;
};

export const queryClient = createQueryClient();

export const asMutation = <TArgs extends unknown[], TData, TError = DefaultError, TOnMutateResult = unknown>(
  fn: (...args: TArgs) => Promise<TData>,
  options?: Omit<CreateMutationOptions<TData, TError, TArgs, TOnMutateResult>, 'mutationFn' | 'mutationKey'>,
) => mutationOptions({ ...options, mutationFn: (args: TArgs) => fn(...args) });

export const createDefinedQuery = <
  TQueryFnData,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UndefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey> & {
    queryKey: DataTag<TQueryKey, TQueryFnData, TError>;
  },
): DefinedCreateQueryResult<TData, TError> => {
  const initialData = queryClient.getQueryData<TQueryFnData, TQueryKey, NonUndefinedGuard<TQueryFnData>>(
    options.queryKey,
  );
  if (initialData === undefined) {
    throw new Error(`${options.queryKey.join('/')} must be loaded first`);
  }

  return createQuery(() => ({ ...options, initialData }));
};

type MutationArgs<TData, TError, TVariables, TContext> = TVariables extends void
  ? [variables?: TVariables, mutateOptions?: MutateOptions<TData, TError, TVariables, TContext>]
  : [variables: TVariables, mutateOptions?: MutateOptions<TData, TError, TVariables, TContext>];

export const executeMutation = <TData, TError, TVariables, TContext>(
  options: CreateMutationOptions<TData, TError, TVariables, TContext>,
  ...[variables, mutateOptions]: MutationArgs<TData, TError, TVariables, TContext>
) => new MutationObserver(queryClient, options).mutate(variables as TVariables, mutateOptions).catch(noop);
