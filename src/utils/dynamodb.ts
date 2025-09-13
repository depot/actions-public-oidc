import {DynamoDBClient} from '@aws-sdk/client-dynamodb'
import {DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand} from '@aws-sdk/lib-dynamodb'
import {addSeconds} from 'date-fns'
import type {webcrypto} from 'node:crypto'
import type {ClaimSchema} from '../types'
import type {JsonWebKeyWithKid, Key} from './oidc'

/**
 * DynamoDB Single Table Design structure:
 *
 * Claims: pk="CLAIM#<claimId>", sk="CLAIM"
 * Keys: pk="CONFIG", sk="KEY#<keyId>"
 * Latest Key: pk="CONFIG", sk="LATEST_KEY"
 * GitHub Session: pk="CONFIG", sk="GITHUB_SESSION"
 */

const TABLE_NAME = process.env.TABLE_NAME || 'actions-public-oidc'
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
})

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {removeUndefinedValues: true, convertClassInstanceToMap: true},
  unmarshallOptions: {},
})

export interface ClaimRecord {
  pk: string
  sk: string
  claimId: string
  issuer: string
  claimData: ClaimSchema
  challengeCode: string
  exchanged: boolean
  ttl: number
  createdAt: string
}

export interface KeyRecord {
  pk: string
  sk: string
  keyId: string
  publicKey: JsonWebKeyWithKid
  privateKey: webcrypto.JsonWebKey
  createdAt: string
  ttl: number
}

export interface ConfigRecord {
  pk: string
  sk: string
  value: string
}

/**
 * Create a new claim with a 5-minute TTL
 */
export async function createClaim(data: {
  claimId: string
  issuer: string
  claimData: ClaimSchema
  challengeCode: string
}): Promise<void> {
  const ttl = Math.floor(addSeconds(new Date(), 5 * 60).getTime() / 1000)

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `CLAIM#${data.claimId}`,
        sk: 'CLAIM',
        claimId: data.claimId,
        issuer: data.issuer,
        claimData: data.claimData,
        challengeCode: data.challengeCode,
        exchanged: false,
        ttl,
        createdAt: new Date().toISOString(),
      } satisfies ClaimRecord,
    }),
  )
}

/**
 * Get a claim by ID
 */
export async function getClaim(claimId: string): Promise<ClaimRecord | null> {
  const result = await docClient.send(
    new GetCommand({TableName: TABLE_NAME, Key: {pk: `CLAIM#${claimId}`, sk: 'CLAIM'}}),
  )
  if (!result.Item) return null
  return result.Item as ClaimRecord
}

/**
 * Atomically mark a claim as exchanged and return the claim data
 */
export async function exchangeClaim(claimId: string): Promise<ClaimRecord | null> {
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {pk: `CLAIM#${claimId}`, sk: 'CLAIM'},
        UpdateExpression: 'SET exchanged = :true',
        ConditionExpression: 'attribute_exists(pk) AND exchanged = :false',
        ExpressionAttributeValues: {':true': true, ':false': false},
        ReturnValues: 'ALL_OLD',
      }),
    )
    if (!result.Attributes) return null
    return result.Attributes as ClaimRecord
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return null
    }
    throw error
  }
}

/**
 * Store a signing key with optional TTL
 */
export async function storeKey(key: Key, expirationSeconds: number): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CONFIG',
        sk: `KEY#${key.id}`,
        keyId: key.id,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + expirationSeconds,
      } satisfies KeyRecord,
    }),
  )
}

/**
 * Get a signing key by ID
 */
export async function getKey(keyId: string): Promise<Key | null> {
  const result = await docClient.send(new GetCommand({TableName: TABLE_NAME, Key: {pk: 'CONFIG', sk: `KEY#${keyId}`}}))
  if (!result.Item) return null

  const item = result.Item as KeyRecord
  return {id: item.keyId, publicKey: item.publicKey, privateKey: item.privateKey}
}

/**
 * Get all signing keys
 */
export async function getAllKeys(): Promise<Key[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {':pk': 'CONFIG', ':skPrefix': 'KEY#'},
    }),
  )

  if (!result.Items) return []

  return (result.Items as KeyRecord[]).map((item) => ({
    id: item.keyId,
    publicKey: item.publicKey,
    privateKey: item.privateKey,
  }))
}

/**
 * Set the latest key ID
 */
export async function setLatestKey(keyId: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {pk: 'CONFIG', sk: 'LATEST_KEY', value: keyId} satisfies ConfigRecord,
    }),
  )
}

/**
 * Get the latest key ID
 */
export async function getLatestKeyId(): Promise<string | null> {
  const result = await docClient.send(new GetCommand({TableName: TABLE_NAME, Key: {pk: 'CONFIG', sk: 'LATEST_KEY'}}))
  if (!result.Item) return null
  return (result.Item as ConfigRecord).value
}

/**
 * Get the latest key
 */
export async function getLatestKey(): Promise<Key | null> {
  const keyId = await getLatestKeyId()
  if (!keyId) return null
  return getKey(keyId)
}

/**
 * Set the GitHub session
 */
export async function setGitHubSession(session: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CONFIG',
        sk: 'GITHUB_SESSION',
        value: session,
      } satisfies ConfigRecord,
    }),
  )
}

/**
 * Get the GitHub session
 */
export async function getGitHubSession(): Promise<string | null> {
  const result = await docClient.send(
    new GetCommand({TableName: TABLE_NAME, Key: {pk: 'CONFIG', sk: 'GITHUB_SESSION'}}),
  )
  if (!result.Item) return null
  return (result.Item as ConfigRecord).value
}
