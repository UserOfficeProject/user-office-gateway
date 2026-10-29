# User Office Gateway

TODO

## Releases

Pushes to `master` create a semantic version tag and GitHub release, then publish
`ghcr.io/userofficeproject/user-office-gateway:<tag>` for AMD64 and ARM64.
The version is determined from conventional commit messages since the previous
tag; when no version bump is specified, the patch version is incremented.
The workflow requires permission to write repository contents and packages.
