import * as cdk from "aws-cdk-lib";
import { KvBenchStack } from "../lib/kv-bench-stack.js";

const app = new cdk.App();
new KvBenchStack(app, "WarefeatsKvBench", {
  env: {
    account: process.env["CDK_DEFAULT_ACCOUNT"],
    region: process.env["CDK_DEFAULT_REGION"],
  },
});
