import { describe, test } from "bun:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { KvBenchStack } from "../lib/kv-bench-stack.js";

describe("KvBenchStack", () => {
  const app = new cdk.App();
  const stack = new KvBenchStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const template = Template.fromStack(stack);

  test("creates 2 launch templates (engine + client)", () => {
    template.resourceCountIs("AWS::EC2::LaunchTemplate", 2);
  });

  test("creates 1 placement group with cluster strategy", () => {
    template.resourceCountIs("AWS::EC2::PlacementGroup", 1);
    template.hasResourceProperties("AWS::EC2::PlacementGroup", {
      Strategy: "cluster",
    });
  });

  test("creates 1 security group", () => {
    template.resourceCountIs("AWS::EC2::SecurityGroup", 1);
  });

  test("engine uses c7g.metal with terminate-on-shutdown", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: {
        InstanceType: "c7g.metal",
        InstanceInitiatedShutdownBehavior: "terminate",
      },
    });
  });

  test("creates instance profiles for launch templates", () => {
    template.resourceCountIs("AWS::IAM::InstanceProfile", 2);
  });

  test("instance role has SSMManagedInstanceCore policy", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: [
        {
          "Fn::Join": [
            "",
            [
              "arn:",
              { Ref: "AWS::Partition" },
              ":iam::aws:policy/AmazonSSMManagedInstanceCore",
            ],
          ],
        },
      ],
    });
  });

  test("creates 1 S3 bucket", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
  });
});
