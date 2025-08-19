# Changesets Workflow

Use `pnpm changeset` to create a new changeset whenever you open a PR that changes user‑facing behavior (bug fixes, features, breaking changes).

Steps:
1. From your feature branch run:
	 ```sh
	 pnpm changeset
	 ```
2. Pick the semver bump (patch | minor | major) for the package.
3. Write a short summary (appears in the changelog).
4. Commit the generated file under `.changeset/` with the rest of your changes.

Release Process:
- Merging feature PRs just accumulates individual changeset markdown files in `.changeset/`.
- The `Release` GitHub Action (on push to `main`) uses `changesets/action`:
	- If there are unpublished changesets it opens / updates a "Release" PR that bumps versions & updates the changelog.
	- When that Release PR is merged into `main`, the workflow runs again, this time publishing the package to npm and deleting the consumed changeset files.

Manual trigger: You can also run the workflow via the Actions tab (workflow_dispatch) if needed.

Scripts:
- `pnpm changeset` start the prompt.
- `pnpm version-packages` (used by the action) versions & builds.
- `pnpm release` publishes (build + `changeset publish`).

Guidance on bump types:
- patch: Backwards compatible bug fix / internal improvement.
- minor: Backwards compatible new feature / enhancement.
- major: Breaking change (API removals, incompatible behavior changes).

Remember: No changeset needed if the change does not affect the published package (docs only, CI only, etc.).

Once the Release PR is merged, publication happens automatically (requires `NPM_TOKEN` secret set). 
