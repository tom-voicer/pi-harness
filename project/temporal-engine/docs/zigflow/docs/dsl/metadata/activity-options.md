# Activity Options | Zigflow

> Source: [https://zigflow.dev/docs/dsl/metadata/activity-options](https://zigflow.dev/docs/dsl/metadata/activity-options)

Activities are the work units that run outside a Workflow and can perform non-deterministic operations. Activity Options let you define how an activity should run: timeouts, retries and other execution settings. These options shape reliability and performance, making each activity call predictable and consistent across SDKs. Configure them when invoking an activity to ensure it behaves the way your Workflow expects.

tip

These are configured to provide sensible defaults which will work for most use cases. In most scenarios, you probably won't need to configure this.

## Location[​](#location "Direct link to Location")

*   Document
*   Task

## Metadata[​](#metadata "Direct link to Metadata")

Name

Type

Required

Description

`activityOptions`

[`ActivityOptions`](#types-activity-options)

`no`

Configure the activity options. If nothing is provided, the default options will be used.

## Types[​](#types "Direct link to Types")

### ActivityOptions[​](#types-activity-options "Direct link to ActivityOptions")

Name

Type

Required

Default

Description

heartbeatTimeout

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

\-

Heartbeat interval. A [`heartbeat`](https://zigflow.dev/docs/dsl/metadata/heartbeat) must be set and be called before the interval passes.

scheduleToCloseTimeout

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

\-

Total time that a workflow is willing to wait for an Activity to complete

scheduleToStartTimeout

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

\-

Time that the Activity Task can stay in the Task Queue before it is picked up by a Worker. Do not specify this timeout unless using host specific Task Queues for Activity Tasks are being used for routing

startToCloseTimeout

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

`{"seconds":15}`

Maximum time of a single Activity execution attempt

retryPolicy

[`RetryPolicy`](#types-retry-policy)

`no`

\-

Specifies how to retry an Activity if an error occurs

disableEagerExecution

`boolean`

`no`

`false`

If `true`, eager execution will not be requested, regardless of worker settings. If `false`, eager execution may still be disabled at the worker level or may not be requested due to lack of available slots.

summary

`string`

`no`

The task's name

Add a summary to the Temporal workflow UI

priority

[`ActivityPriority`](#types-activity-priority)

`no`

\-

Configure an activity's priority and fairness

### ActivityPriority[​](#types-activity-priority "Direct link to ActivityPriority")

Name

Type

Required

Default

Description

`priorityKey`

`integer`

`no`

\-

A positive integer from 1 to *n*, where smaller integers correspond to higher priorities (tasks run sooner)

`fairnessKey`

`string`

`no`

\-

A short string that's used as a key for a fairness balancing mechanism

`fairnessWeight`

`float`

`no`

\-

Weight of a task can come from multiple sources for flexibility

### RetryPolicy[​](#types-retry-policy "Direct link to RetryPolicy")

Name

Type

Required

Default

Description

`initialInterval`

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

`{"second":1}`

Backoff interval for the first retry. If BackoffCoefficient is `1.0` then it is used for all retries

`backoffCoefficient`

`float`

`no`

`2.0`

Coefficient used to calculate the next retry backoff interval

`maximumInterval`

[`duration`](https://zigflow.dev/docs/dsl/intro#duration)

`no`

`{"minute":1}`

Maximum backoff interval between retries

`maximumAttempts`

`integer`

`no`

`5`

Maximum number of attempts. When exceeded the retries stop even if not expired yet

`nonRetryableErrorTypes`

`string[]`

`no`

`[]`

Temporal server will stop retry if error type matches this list