import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture projects are analyzed statically; their own *.test.* files must never run.
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    environment: 'node',
    testTimeout: 30_000,
    // CLI runs against the fixture folders must not leave a warm cache there (copies would inherit it);
    // tests of the cache itself opt in explicitly.
    // `check` appends a job summary in GitHub Actions: tests running inside CI must not write to the real one.
    // The base branch follows a pull request's target in CI: tests inside a CI job must not see the job's.
    env: {
      CODE_VISUALIZER_NO_CACHE: '1',
      GITHUB_STEP_SUMMARY: '',
      GITHUB_BASE_REF: '',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: '',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: '',
      BITBUCKET_PR_DESTINATION_BRANCH: '',
      SYSTEM_PULLREQUEST_TARGETBRANCH: '',
      CHANGE_TARGET: '',
    },
    hookTimeout: 60_000,
  },
});
