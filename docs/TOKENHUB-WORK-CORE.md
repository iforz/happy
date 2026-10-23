# Happy Work gateway adapter

This optional Happy integration connects the existing Work experiment page to a
compatible TokenHub service. The normal session composer is unchanged. The
adapter is disabled by default and this change does not deploy or activate it.

## Happy configuration and interface

`TOKENHUB_GATEWAY_MODE` accepts `disabled`, `mock`, or `real`; mock and real modes
are mutually exclusive. Real mode requires the existing Happy Work authorization
configuration and `TOKENHUB_CORE_GATEWAY_URL`, a fixed literal loopback HTTP origin.
The client cannot supply the service URL or provider credentials.

The existing authenticated Happy endpoints are:

- `GET /v1/tokenhub/work/models`: returns the available model list and identifies
  real mode with `mode:"real"` and `billable:true`.
- `POST /v1/tokenhub/work/stream`: accepts `{model,prompt,requestId?}`. The optional
  request ID is a UUID. The page creates one for each new action. Model IDs are
  limited to 200 characters, prompts to 4,000 and the JSON body to 32 KiB.

The response is NDJSON with `delta`, `usage`, `done`, or `error` records. The
client action UUID remains `usage.requestId`; a separate optional `coreRequestId`
can be used for support. Usage counts are display information, not proof of a
committed charge. The account service's records remain authoritative.

## User-visible failure behavior

Real requests may be billable. An interrupted or cancelled response does not
mean no usage occurred. The adapter does not automatically retry or issue
refunds. A duplicate-request response is shown without another model request.
Missing usage, malformed responses, timeout and interrupted streams do not
become successful zero-usage completions. Users should check their account
records rather than retrying an uncertain action with a new identifier.

Signing out or cancelling stops Happy's request. Real-mode errors remain separate
from invalid-session errors so a service rejection does not unnecessarily sign
out the user. The existing non-billable mock remains available independently.

## Verification boundary

Happy tests exercise the relay, authorization and client parsing against a local
fake service. They do not call a paid model or modify production account data.
They do not prove the remote service's billing correctness or approve deployment.
Run `coreGateway.spec.ts`, `tokenHubCoreWorkRoutes.spec.ts`, existing Work
application tests, and production typechecks before shipping this adapter.
