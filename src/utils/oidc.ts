import {base64url} from 'rfc4648'
import type {TokenClaims} from '../types'

const keyAlg = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: {name: 'SHA-256'},
}

export interface TokenParams {
  issuer: string
  audience: string
  keyID: string
  privateKey: JsonWebKey
  claims: TokenClaims
}

export async function issueToken({issuer, audience, keyID, privateKey: privateKeyData, claims}: TokenParams) {
  const privateKey = await importPrivateKey(keyID, privateKeyData)

  const header = {alg: 'RS256', typ: 'JWT', kid: keyID}
  const timestamp = Math.floor(Date.now() / 1000) // seconds
  const payload = {
    aud: audience,
    iss: issuer,
    jti: crypto.randomUUID(),
    iat: timestamp,
    nbf: timestamp,
    exp: timestamp + 60 * 5, // 5 minutes
    ...claims,
  }

  const encodedMessage = `${encodeObject(header)}.${encodeObject(payload)}`
  const encodedMessageArrBuf = stringToArrayBuffer(encodedMessage)

  const signatureArrBuf = await crypto.subtle.sign(
    {name: keyAlg.name, hash: keyAlg.hash},
    privateKey,
    encodedMessageArrBuf,
  )
  const signatureUint8Array = new Uint8Array(signatureArrBuf)
  const encodedSignature = base64url.stringify(signatureUint8Array, {pad: false})
  return `${encodedMessage}.${encodedSignature}`
}

export function stringToArrayBuffer(str: string) {
  const buf = new ArrayBuffer(str.length)
  const bufView = new Uint8Array(buf)
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i)
  }
  return buf
}

export function encodeObject(object: object) {
  return base64url.stringify(new TextEncoder().encode(JSON.stringify(object)), {pad: false})
}

const _privateKeyMap = new Map<string, CryptoKey>()
async function importPrivateKey(keyID: string, keyData: JsonWebKey) {
  const existing = _privateKeyMap.get(keyID)
  if (existing) return existing
  const privateKey = await crypto.subtle.importKey('jwk', keyData, keyAlg, true, ['sign'])
  _privateKeyMap.set(keyID, privateKey)
  return privateKey
}

export interface Key {
  id: string
  publicKey: JsonWebKeyWithKid
  privateKey: JsonWebKey
}

export async function generateKey(): Promise<Key> {
  const keyPair = (await crypto.subtle.generateKey(keyAlg, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const privateKey = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey
  const keyID = crypto.randomUUID()
  return {id: keyID, publicKey: {...publicKey, kid: keyID}, privateKey}
}
