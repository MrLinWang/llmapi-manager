import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { addWarning } from '../resilience';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;

export interface SecretCodec {
  readonly encrypted: boolean;
  encode(plain: string): string;
  decode(stored: string): string;
}

/** 无密钥时的直通实现：可用但会在启动告警里明确提示。 */
function plainCodec(): SecretCodec {
  return {
    encrypted: false,
    encode: (plain) => plain,
    decode: (stored) => stored,
  };
}

export function createSecretCodec(encryptionKey: string | undefined): SecretCodec {
  if (!encryptionKey) {
    addWarning('plaintext_credentials', 'warnings.plaintextCredentials');
    return plainCodec();
  }

  // 盐值属于加密参数而非项目名：改它会让已落盘的密文无法解密，因此保持不动
  const key = scryptSync(encryptionKey, 'llmapi-hub.secret.v1', 32);

  return {
    encrypted: true,
    encode(plain: string): string {
      if (plain === '') return '';
      if (plain.startsWith(PREFIX)) return plain;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
    },
    decode(stored: string): string {
      if (!stored.startsWith(PREFIX)) return stored;
      const body = stored.slice(PREFIX.length);
      const [ivPart, tagPart, dataPart] = body.split(':');
      if (!ivPart || !tagPart || !dataPart) return '';
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(ivPart, 'base64url'),
        );
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // 密钥变更后无法解密：返回空串让上层按"无凭据"处理，而不是崩溃
        addWarning('credential_decrypt_failed', 'warnings.credentialDecryptFailed');
        return '';
      }
    },
  };
}
