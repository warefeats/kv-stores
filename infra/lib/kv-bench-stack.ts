import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export class KvBenchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "ResultsBucket", {
      bucketName: `warefeats-kv-bench-results-${this.account}`,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
    });

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const sg = new ec2.SecurityGroup(this, "BenchSg", {
      vpc,
      description: "KV bench — intra-group traffic only",
      allowAllOutbound: true,
    });
    sg.addIngressRule(sg, ec2.Port.allTraffic(), "intra-group");

    const placementGroup = new ec2.PlacementGroup(this, "BenchPlacement", {
      strategy: ec2.PlacementGroupStrategy.CLUSTER,
    });

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });
    bucket.grantPut(role);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "shutdown -h +120",
      "apt-get update -y",
      "apt-get install -y docker.io docker-compose-v2 docker-buildx jq curl git awscli",
      "systemctl enable docker && systemctl start docker",
      "curl -fsSL https://bun.sh/install | bash",
      'export BUN_INSTALL="/root/.bun"',
      'export PATH="$BUN_INSTALL/bin:$PATH"',
      "git clone https://github.com/warefeats/kv-stores.git /opt/bench",
      "cd /opt/bench && bun install",
    );

    const engineLt = new ec2.LaunchTemplate(this, "EngineLt", {
      instanceType: new ec2.InstanceType("c7g.metal"),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id",
      ),
      role,
      userData,
      securityGroup: sg,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });
    (engineLt.node.defaultChild as ec2.CfnLaunchTemplate).addPropertyOverride(
      "LaunchTemplateData.InstanceInitiatedShutdownBehavior",
      "terminate",
    );
    (engineLt.node.defaultChild as ec2.CfnLaunchTemplate).addPropertyOverride(
      "LaunchTemplateData.Placement.GroupName",
      placementGroup.placementGroupName,
    );

    const clientLt = new ec2.LaunchTemplate(this, "ClientLt", {
      instanceType: new ec2.InstanceType("c7g.xlarge"),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id",
      ),
      role,
      userData,
      securityGroup: sg,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });
    (clientLt.node.defaultChild as ec2.CfnLaunchTemplate).addPropertyOverride(
      "LaunchTemplateData.InstanceInitiatedShutdownBehavior",
      "terminate",
    );
    (clientLt.node.defaultChild as ec2.CfnLaunchTemplate).addPropertyOverride(
      "LaunchTemplateData.Placement.GroupName",
      placementGroup.placementGroupName,
    );

    new cdk.CfnOutput(this, "EngineLtId", { value: engineLt.launchTemplateId! });
    new cdk.CfnOutput(this, "ClientLtId", { value: clientLt.launchTemplateId! });
    new cdk.CfnOutput(this, "PlacementGroup", { value: placementGroup.placementGroupName! });
    new cdk.CfnOutput(this, "SecurityGroupId", { value: sg.securityGroupId });
    new cdk.CfnOutput(this, "InstanceRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "ResultsBucketName", { value: bucket.bucketName });
  }
}
