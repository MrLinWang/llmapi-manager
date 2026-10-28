import type { zhWarnings } from '../zh/warnings';

export const enWarnings: typeof zhWarnings = {
  setupPending:
    'No admin account yet: open the console and finish setup with the one-time token printed in the startup log.',
  plaintextCredentials:
    'DATA_ENCRYPTION_KEY is not set, so provider API keys will be stored in plaintext under data/. Use this only for single-machine self-hosting.',
  credentialDecryptFailed:
    'Some provider credentials cannot be decrypted — usually because DATA_ENCRYPTION_KEY changed. Re-enter that provider’s API key.',
  corruptFileQuarantined:
    'Data file {{file}} could not be parsed. It was quarantined as {{target}} and the service started with empty data.',
  corruptFileNotQuarantined: 'Data file {{file}} could not be parsed and could not be quarantined.',
};
