import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * One bucket + one scoped writer, for the .asciiv baked embeds.
 *
 * - Objects are PUBLIC-READ (embeds fetch them straight from S3). Writes are NOT public — the browser
 *   uploads via a presigned POST minted by the /api/save Vercel function, which holds the writer key.
 * - The writer IAM user can do nothing but PutObject into this bucket (blast radius = one bucket).
 * - Objects auto-expire after 30 days so abandoned/spam clips don't accumulate storage cost.
 */
export class AsciivStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "ClipsBucket", {
      bucketName: `ascii-video-clips-${this.account}`,
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false, // allow the public-read bucket policy publicReadAccess adds
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          // GET: embeds fetch the .asciiv from anywhere. POST: browser presigned-POST upload. HEAD: range/probe.
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const writer = new iam.User(this, "Writer", { userName: "asciiv-writer" });
    bucket.grantPut(writer); // s3:PutObject on this bucket only
    const key = new iam.AccessKey(this, "WriterKey", { user: writer });

    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "Region", { value: this.region });
    new cdk.CfnOutput(this, "AccessKeyId", { value: key.accessKeyId });
    // Secret is emitted so we can lift it into Vercel env once; treat it as sensitive.
    new cdk.CfnOutput(this, "SecretAccessKey", { value: key.secretAccessKey.unsafeUnwrap() });
  }
}
