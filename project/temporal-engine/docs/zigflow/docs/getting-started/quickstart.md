# Quickstart | Zigflow

> Source: [https://zigflow.dev/docs/getting-started/quickstart](https://zigflow.dev/docs/getting-started/quickstart)

Get Zigflow installed and run your first workflow in under five minutes.

tip

Still deciding between Zigflow and the [Temporal SDK](https://zigflow.dev/docs/concepts/comparing-zigflow-and-temporal-sdks)? Read the comparison first.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to install the Zigflow binary and validate a workflow file
*   How to start a local Temporal development server
*   How to start a Zigflow worker and trigger a workflow execution
*   How to view the result and troubleshoot common errors

## Prerequisites[​](#prerequisites "Direct link to Prerequisites")

*   A terminal (Linux, macOS or Windows with WSL)
*   [Temporal CLI](https://docs.temporal.io/cli) installed

* * *

## Step 1: Install Zigflow[​](#step-1-install-zigflow "Direct link to Step 1: Install Zigflow")

```
brew tap zigflow/tapbrew install --cask zigflow
```

Verify it is working:

```
zigflow version
```

You should see the version number and commit hash.

* * *

## Step 2: Start a Temporal server[​](#step-2-start-a-temporal-server "Direct link to Step 2: Start a Temporal server")

Zigflow requires a Temporal server. For local development, use the development server bundled with the [Temporal CLI](https://docs.temporal.io/cli):

```
temporal server start-dev
```

Leave this running in a separate terminal. The Temporal UI will be available at [http://localhost:8233](http://localhost:8233/).

* * *

## Step 3: Create a workflow file[​](#step-3-create-a-workflow-file "Direct link to Step 3: Create a workflow file")

Create a file named `workflow.yaml`:

workflow.yaml

```
document:  dsl: 1.0.0  taskQueue: zigflow  workflowType: hello-world  version: 1.0.0do:  - greet:      set:        message: Hello from Ziggy      output:        as:          data: ${ . }
```

What this does:

*   `document.taskQueue`: sets the Temporal task queue to `zigflow`
*   `document.workflowType`: sets the Temporal workflow type to `hello-world`
*   `do`: a list of tasks to run in order; each key (`greet`) is an arbitrary step name you choose. It is not a reserved keyword.
*   `set`: stores `message` into the workflow state
*   `output.as`: transforms the task output before returning it

* * *

## Step 4: Validate[​](#step-4-validate "Direct link to Step 4: Validate")

Check the workflow is valid before running it:

```
zigflow validate workflow.yaml
```

A valid workflow prints nothing and exits with code 0. An invalid workflow prints a human-readable error. For example, if `document.workflowType` is missing:

```
❌ Validation failed for workflow.yaml1 validation error(s):1. document.workflowType: is required
```

Each error includes the field path and a description of the rule that failed. Fix the field, then re-validate.

* * *

## Step 5: Start the worker[​](#step-5-start-the-worker "Direct link to Step 5: Start the worker")

```
zigflow run -f workflow.yaml
```

You should see log output indicating the worker has started and is connected to Temporal.

* * *

## Step 6: Trigger the workflow[​](#step-6-trigger-the-workflow "Direct link to Step 6: Trigger the workflow")

Leave the worker running and open a new terminal. Trigger the workflow using the Temporal CLI:

```
temporal workflow start \  --type hello-world \  --task-queue zigflow \  --workflow-id my-first-workflow
```

* * *

## Step 7: View the result[​](#step-7-view-the-result "Direct link to Step 7: View the result")

Option 1: Temporal CLI:

```
temporal workflow show --workflow-id my-first-workflow
```

Option 2: Temporal UI:

1.  Open [http://localhost:8233](http://localhost:8233/)
2.  Click on the `hello-world` workflow execution
3.  View the result in the "Output" tab

Expected output:

```
{  "data": {    "message": "Hello from Ziggy"  }}
```

* * *

## Troubleshooting[​](#troubleshooting "Direct link to Troubleshooting")

### The worker exits immediately[​](#the-worker-exits-immediately "Direct link to The worker exits immediately")

Run `zigflow validate workflow.yaml` to see the validation error. Fix the error and retry.

### "Unable to connect to Temporal"[​](#unable-to-connect-to-temporal "Direct link to \"Unable to connect to Temporal\"")

Check that the Temporal development server is running:

```
temporal server start-dev
```

### "No workers are registered for this task queue"[​](#no-workers-are-registered-for-this-task-queue "Direct link to \"No workers are registered for this task queue\"")

The task queue in your workflow file must match the task queue you use when starting the execution. The value is `document.taskQueue` in your YAML file.

### "Workflow type not found"[​](#workflow-type-not-found "Direct link to \"Workflow type not found\"")

The workflow type must match `document.workflowType` in your YAML file. Check for typos.

### The worker shows no output after starting[​](#the-worker-shows-no-output-after-starting "Direct link to The worker shows no output after starting")

By default, the log level is `info`. To see debug output:

```
zigflow run -f workflow.yaml --log-level debug
```

* * *

## Next steps[​](#next-steps "Direct link to Next steps")

*   [Concepts: Overview](https://zigflow.dev/docs/concepts/overview): the mental model behind Zigflow
*   [Your first workflow](https://zigflow.dev/docs/getting-started/your-first-workflow): triggering from application code
*   [Examples](https://zigflow.dev/docs/examples/): more patterns with step-by-step walkthroughs
*   [DSL reference](https://zigflow.dev/docs/dsl/intro): full workflow YAML reference
*   [CLI reference](https://zigflow.dev/docs/cli/commands/zigflow_run): all `run` flags