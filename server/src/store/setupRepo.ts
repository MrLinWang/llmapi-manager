import type { Logger } from '../logger';
import { createJsonFile } from './jsonFile';
import type { StorePaths } from './paths';
import { defaultSetupState, type SetupState } from '../domain/setup';

export interface SetupRepo {
  read(): SetupState;
  write(state: SetupState): void;
}

export function createSetupRepo(paths: StorePaths, logger?: Logger): SetupRepo {
  const file = createJsonFile<{ setup: SetupState }>({
    filePath: paths.setupFile,
    schemaVersion: 1,
    defaultValue: () => ({ setup: defaultSetupState() }),
    logger,
  });

  return {
    read: () => ({ ...defaultSetupState(), ...(file.read().setup ?? {}) }),
    write: (state) => file.write({ setup: state }),
  };
}
