#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AsciivStack } from "../lib/asciiv-stack";

const app = new cdk.App();
new AsciivStack(app, "AsciivStack", {
  // Use the account/region from the ambient AWS credentials (the local `cdk-deploy` user).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-1" },
  description: "ascii-video: S3 bucket + scoped writer for .asciiv baked embeds",
});
