# Wait | Zigflow

> Source: [https://zigflow.dev/docs/dsl/tasks/wait](https://zigflow.dev/docs/dsl/tasks/wait)

Allows workflows to pause or delay their execution for a specified period of time. This converts to a Temporal [Durable Timer](https://docs.temporal.io/workflow-execution/timers-delays).

Use Wait to introduce a durable delay into your workflow. The timer survives worker restarts. Typical uses include cooldown periods, scheduled actions and pauses between retry attempts.

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: example  version: 0.0.1do:  - wait:      wait:        seconds: 5
```

**The timer is durable.** A wait of hours or days survives worker restarts. Temporal holds the timer state. This is intended behaviour.

**There is no maximum duration.** Very long timers are supported by Temporal but increase workflow history length.