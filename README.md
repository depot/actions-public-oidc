# actions-public-oidc

An OIDC issuer for `pull_request` GitHub Actions workflows triggered by open-source forks.

## Usage

```typescript
import * as oidc from '@depot/actions-public-oidc-client'

const token = await getIDToken()
```

## Background

GitHub Actions workflows triggered by `pull_request` events from forks do not have access to Actions secrets, including Actions OIDC tokens. This makes it difficult to identify the workflow and authenticate with third-party services.

## How it works

This issuer offers a flow for acquiring an OIDC token for the untrusted public `pull_request` workflow. The token identifies the properties of the workflow, including the repository, workflow, and run ID. The token is signed by the issuer and can be verified by the third-party service.

The authentication and exchange flow works as follows:

1. The GitHub Actions workflow makes a "claim request" to the OIDC issuer with details about the workflow (e.g., the repository, the workflow ID, the run ID, etc.)
2. The OIDC issuer responds with a unique "challenge code" for the workflow to print periodically in the workflow logs
3. While the workflow prints the challenge code, the OIDC issuer watches the build logs using the GitHub API and validates that the claiming workflow is printing the correct challenge code
4. Once the issuer has validated the challenge code, it returns a new OIDC token to the workflow, encapsulating the details about the workflow run inside the token claims

👉 [More information](https://depot.dev/blog/github-actions-oss-fork-builds)

## License

MIT License, see [LICENSE](./LICENSE).
