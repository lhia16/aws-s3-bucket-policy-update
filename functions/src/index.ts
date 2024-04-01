import { DynamoDBStreamHandler } from "aws-lambda";
import {
  S3Client,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const DYNAMODB_TABLE_NAME = "table-name";
const POLICY_SID = "DeploymentAccess";

// Creating DynamoDB client
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const s3 = new S3Client({});

// Interface for Account property within Customer record
interface Account {
  ID: string;
  Name: string;
  Enabled: boolean;
  RoleName: string;
  Environment: string[];
  AdminOnly?: boolean;
  ExternalID?: string;
}

// Interface for Customer record
interface Customer {
  ID: string;
  Name: string;
  Created: string;
  Active: boolean;
  Accounts: Array<Account>;
  Logo?: string;
}

// Gets account ids from each customer record 
const getAccountIdsFromDynamoDB = async () => {
  const { Items } = await dynamodb.send(
    new ScanCommand({
      TableName: DYNAMODB_TABLE_NAME,
      ExpressionAttributeNames: {
        "#A": "Accounts",
      },
      ProjectionExpression: "#A",
    })
  );
  const records = (Items ?? []) as Customer[];
  const accountIds = Array.from(
    new Set(
      records.flatMap((item) => item.Accounts.map((account) => account.ID))
    )
  );
  return accountIds;
};
// Interface for S3 Bucket policy statement
interface S3BucketPolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal: {
    Service?: string;
    AWS?: string | string[];
  };
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, any>;
}

// Interface for S3 Bucket policy
interface S3BucketPolicy {
  Version: string;
  Id?: string;
  Statement: S3BucketPolicyStatement[];
}

// Gets the current bucket policy for the lambda bundles bucket in each region
const getCurrentBucketPolicy = async (client: S3Client, bucket: string) => {
  try {
    const { Policy } = await client.send(
      new GetBucketPolicyCommand({
        Bucket: bucket,
      })
    );
    const currentPolicy = JSON.parse(Policy || "{}") as S3BucketPolicy;

    return currentPolicy;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "Code" in error &&
      error.Code === "NoSuchBucketPolicy"
    ) {
      return { Statement: [], Version: "2012-10-17" } as S3BucketPolicy;
    } else {
      throw error;
    }
  }
};

// Updates the bucket policy for the lambda bundles bucket in each region
const updateBucketPolicy = (
  bucket: string,
  currentPolicy: S3BucketPolicy,
  accountIds: string[]
): S3BucketPolicy => {
  const updatedStatement = {
    Sid: POLICY_SID,
    Effect: "Allow",
    Principal: {
      AWS: accountIds.map((accountId) => `arn:aws:iam::${accountId}:root`),
    },
    Action: [
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:GetObjectAttributes",
      "s3:GetObjectVersion",
      "s3:GetObjectVersionTagging",
      "s3:GetObjectVersionAttributes",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectAcl",
    ],
    Resource: `arn:aws:s3:::${bucket}/*`,
  } as S3BucketPolicyStatement;

  const otherStatements = currentPolicy.Statement.filter(
    (statement) => statement.Sid !== POLICY_SID
  );

  const statements = otherStatements.concat(updatedStatement);
  return {
    ...currentPolicy,
    Statement: statements,
  };
};

// Return buckets with specified prefix
const listLambdaBundleBuckets = async () => {
  const response = await s3.send(new ListBucketsCommand({}));
  const buckets = response.Buckets ?? [];

  return buckets
    .map((bucket) => bucket.Name ?? "")
    .filter((bucket) => bucket.startsWith("some-prefix-lambdabundles-"));
};

export const handler: DynamoDBStreamHandler = async () => {
  try {
    const accountIds = await getAccountIdsFromDynamoDB();
    const buckets = await listLambdaBundleBuckets();

    for (const bucket of buckets) {
      const region = bucket.slice(25);
      const client = new S3Client({ region });
      const currentPolicy = await getCurrentBucketPolicy(client, bucket);

      const updatedPolicy = updateBucketPolicy(
        bucket,
        currentPolicy,
        accountIds
      );

      const policy = JSON.stringify(updatedPolicy);

      const bucketPolicyParams = new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: policy,
      });

      await client.send(bucketPolicyParams);
    }
    console.log("S3 bucket policy updated successfully!");
  } catch (error) {
    console.error("Error processing DynamoDB event:", error);
    throw error;
  }
};
