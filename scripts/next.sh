#!/bin/sh
# Makes the branch next: main with the open PRs that have the label "next". The push publishes a preview (release.yml),
# for the test on a Mac: npx figpal@next install. Usage: pnpm next
set -eu

branches=$(gh pr list --state open --label next --json headRefName --jq '.[].headRefName')
if [ -z "$branches" ]; then
	echo "No open PR has the label next. Add it to the PRs to try: gh pr edit <number> --add-label next"
	exit 1
fi
# shellcheck disable=SC2086 # One argument for each branch.
git fetch --quiet origin main $branches
work=$(mktemp -d)
git worktree add --quiet --detach "$work" origin/main
trap 'git worktree remove --force "$work"' EXIT
for branch in $branches; do
	if ! git -C "$work" merge --quiet --no-edit "origin/$branch"; then
		echo "$branch does not merge with main and the PRs before it. Rebase it on main, then run pnpm next again."
		exit 1
	fi
	echo "Merged $branch."
done
git -C "$work" push --quiet --force origin HEAD:refs/heads/next
echo "next is main with these branches. In about 10 minutes: npx figpal@next install"
