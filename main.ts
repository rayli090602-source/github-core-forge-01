import { reportEntryFailure, runForgeEntry } from './entry-runtime.ts';

try {
  await runForgeEntry();
  process.exitCode = 0;
} catch (error) {
  reportEntryFailure(error);
  process.exitCode = 1;
}

