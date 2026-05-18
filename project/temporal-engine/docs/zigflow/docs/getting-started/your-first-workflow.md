# Your First Workflow | Zigflow

> Source: [https://zigflow.dev/docs/getting-started/your-first-workflow](https://zigflow.dev/docs/getting-started/your-first-workflow)

```
package mainimport (  "context"  "fmt"  "go.temporal.io/sdk/client")func main() {  client, err := client.Dial(client.Options{})  if err != nil {    panic(err)  }  defer client.Close()  workflowOptions := client.StartWorkflowOptions{    TaskQueue: "zigflow",  }  ctx := context.Background()  workflowRun, err := client.ExecuteWorkflow(ctx, workflowOptions, "simple-workflow")  if err != nil {    panic(err)  }  var result any  workflowRun.Get(ctx, &result)  r, err := json.MarshalIndent(result, "", "  ")  if err != nil {    panic(err)  }  fmt.Println(string(r))}
```