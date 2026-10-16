import {
  createLibrary,
  deleteLibrary,
  getAllLibraries,
  getLibrary,
  getLibraryStatistics,
  scanLibrary,
  updateLibrary,
  type LibraryResponseDto,
  type UpdateLibraryDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { mutationOptions, queryOptions } from '@tanstack/svelte-query';
import { asMutation, queryClient } from '$lib/queries/client';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getAllLibrariesQuery = () =>
  queryOptions({
    queryKey: ['libraries'],
    queryFn: ({ signal }) => getAllLibraries({ signal }),
    staleTime: Infinity,
  });

export const getLibraryQuery = (id: string) =>
  queryOptions({
    queryKey: ['libraries', id],
    queryFn: ({ signal }) => getLibrary({ id }, { signal }),
    staleTime: Infinity,
  });

export const getLibraryStatisticsQuery = (id: string) =>
  queryOptions({
    queryKey: ['libraries', id, 'statistics'],
    queryFn: ({ signal }) => getLibraryStatistics({ id }, { signal }),
    refetchInterval: 30_000,
  });

export const createLibraryMutation = () =>
  asMutation(createLibrary, {
    onSuccess: async (library) => {
      queryClient.setQueryData(getLibraryQuery(library.id).queryKey, library);
      await queryClient.invalidateQueries({ queryKey: getAllLibrariesQuery().queryKey, exact: true });

      const $t = await getFormatter();
      toastManager.primary($t('admin.library_created', { values: { library: library.name } }));
    },
    onError: async (error) => {
      const $t = await getFormatter();
      handleError(error, $t('errors.unable_to_create_library'));
    },
  });

export const renameLibraryMutation = () => updateMutation((_, { name }: { name: string }) => ({ name }));

export const addLibraryImportPathMutation = () =>
  updateMutation((library, { path }: { path: string }) => ({ importPaths: [...library.importPaths, path] }));

export const replaceLibraryImportPathMutation = () =>
  updateMutation((library, { oldValue, newValue }: { oldValue: string; newValue: string }) => ({
    importPaths: library.importPaths.map((path) => (path === oldValue ? newValue : path)),
  }));

export const removeLibraryImportPathMutation = () =>
  updateMutation((library, { path }: { path: string }) => ({
    importPaths: library.importPaths.filter((importPath) => importPath !== path),
  }));

export const addLibraryExclusionPatternMutation = () =>
  updateMutation((library, { pattern }: { pattern: string }) => ({
    exclusionPatterns: [...library.exclusionPatterns, pattern],
  }));

export const replaceLibraryExclusionPatternMutation = () =>
  updateMutation((library, { oldValue, newValue }: { oldValue: string; newValue: string }) => ({
    exclusionPatterns: library.exclusionPatterns.map((pattern) => (pattern === oldValue ? newValue : pattern)),
  }));

export const removeLibraryExclusionPatternMutation = () =>
  updateMutation((library, { pattern }: { pattern: string }) => ({
    exclusionPatterns: library.exclusionPatterns.filter((exclusionPattern) => exclusionPattern !== pattern),
  }));

const updateMutation = <TVariables>(build: (library: LibraryResponseDto, variables: TVariables) => UpdateLibraryDto) =>
  mutationOptions({
    mutationFn: async (variables: TVariables & { id: string }) => {
      const library = await queryClient.query(getLibraryQuery(variables.id));
      return updateLibrary({ id: variables.id, updateLibraryDto: build(library, variables) });
    },
    onSuccess: onLibraryUpdateSuccess,
    onError: onLibraryUpdateError,
  });

const onLibraryUpdateSuccess = async (library: LibraryResponseDto) => {
  queryClient.setQueryData(getLibraryQuery(library.id).queryKey, library);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: getAllLibrariesQuery().queryKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: getLibraryStatisticsQuery(library.id).queryKey }),
  ]);

  const $t = await getFormatter();
  toastManager.primary($t('admin.library_updated'));
};

const onLibraryUpdateError = async (error: unknown) => {
  const $t = await getFormatter();
  handleError(error, $t('errors.unable_to_update_library'));
};

export const deleteLibraryMutation = () =>
  asMutation(deleteLibrary, {
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getAllLibrariesQuery().queryKey });

      const $t = await getFormatter();
      toastManager.primary($t('admin.library_deleted'));
    },
    onError: async (error) => {
      const $t = await getFormatter();
      handleError(error, $t('errors.unable_to_remove_library'));
    },
  });

export const scanLibraryMutation = () =>
  asMutation(scanLibrary, {
    onSuccess: async () => {
      const $t = await getFormatter();
      toastManager.info($t('admin.scanning_library'));
    },
    onError: async (error) => {
      const $t = await getFormatter();
      handleError(error, $t('errors.unable_to_scan_library'));
    },
  });
