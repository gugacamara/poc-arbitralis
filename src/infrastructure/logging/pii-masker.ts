/**
 * Mascaramento de PII para logs.
 *
 * Estrategia em duas camadas, por defesa em profundidade:
 *
 * 1. **Por chave** — campos cujo *nome* denuncia PII (`phone`, `profileName`,
 *    `wa_id`, ...) sao mascarados independentemente do formato do valor. E a
 *    camada principal: nome proprio nao tem formato detectavel por regex, so
 *    da para saber que `contactName` contem um nome porque a chave diz isso.
 *
 * 2. **Por padrao** — regex sobre qualquer string, para capturar telefone,
 *    e-mail ou CPF que apareca dentro de texto livre (uma mensagem de erro de
 *    upstream, por exemplo), onde a chave nao ajuda.
 *
 * Vies deliberado para o **fail-safe**: na duvida, mascara. Um id numerico
 * longo tratado como telefone atrapalha um debug; um telefone real em log
 * agregado e incidente de privacidade.
 */

/** Substituidos por marcador de tamanho: o conteudo inteiro e PII em potencial. */
const REDACTED_KEYS = new Set([
  'text',
  'body',
  'caption',
  'content',
  'message',
  'transcript',
  'prompt',
  'completion',
]);

const PHONE_KEYS = new Set([
  'phone',
  'phonenumber',
  'phone_number',
  'from',
  'to',
  'recipient',
  'sender',
  'msisdn',
  'waid',
  'wa_id',
  'displayphonenumber',
  'display_phone_number',
]);

const NAME_KEYS = new Set([
  'name',
  'fullname',
  'full_name',
  'username',
  'profilename',
  'profile_name',
  'contactname',
  'contact_name',
]);

const EMAIL_KEYS = new Set(['email', 'mail', 'e_mail']);

/** Segredos nao tem valor algum em log, nem parcial. */
const SECRET_KEYS = new Set([
  'authorization',
  'password',
  'token',
  'accesstoken',
  'access_token',
  'apikey',
  'api_key',
  'secret',
  'signature',
]);

/**
 * Limita a recursao: payload de webhook e entrada externa, nao confiavel.
 *
 * Calibrado para caber um payload real da Meta Cloud API, que aninha cerca de
 * dez niveis (`entry[] > changes[] > value > messages[] > text > body`) — cada
 * array conta como um nivel. Limite mais apertado trunca payload legitimo e
 * deixa o log sem valor diagnostico, que e o oposto do objetivo.
 */
const MAX_DEPTH = 12;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CPF_PATTERN = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
/**
 * Sequencia de digitos com cara de telefone, tolerando `+`, espacos, hifens e
 * parenteses.
 *
 * Os lookarounds sao essenciais: sem eles a regex casa *dentro* de
 * identificadores como UUID (`...-8064-0338-...`) e wamid, corrompendo
 * justamente os campos de correlacao que o log existe para preservar.
 */
const PHONE_PATTERN = /(?<![\w-])\+?\d[\d\s().-]{6,}\d(?![\w-])/g;

/**
 * Faixa de um telefone real: E.164 admite ate 15 digitos; o minimo pratico e 8.
 *
 * Um epoch em milissegundos (13 digitos) cai nesta faixa e sera mascarado se
 * aparecer solto em texto livre — falso positivo aceito de proposito, porque a
 * alternativa e deixar passar telefone internacional. Campos numericos
 * estruturados (`timestamp`, `durationMs`, `latencyMs`) nao sao afetados: sao
 * `number`, e o mascarador so inspeciona strings.
 */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

/** Mascara PII em uma string livre, sem qualquer pista de nome de campo. */
export function maskText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, maskEmail)
    .replace(CPF_PATTERN, (cpf) => `***.***.***-${cpf.slice(-2)}`)
    .replace(PHONE_PATTERN, maskPhoneIfPlausible);
}

/** Mascara PII recursivamente em um objeto de contexto de log. */
export function maskContext(context: Record<string, unknown>): Record<string, unknown> {
  return maskObject(context, 0, new WeakSet());
}

/**
 * Segunda barreira contra falso positivo: sequencia longa ou curta demais para
 * ser telefone volta intacta. Protege timestamps em milissegundos e ids
 * numericos, que perderiam todo o valor diagnostico se mascarados.
 */
function maskPhoneIfPlausible(match: string): string {
  const digits = match.replace(/\D/g, '').length;

  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS
    ? maskPhone(match)
    : match;
}

/**
 * Mantem prefixo do pais e os 4 ultimos digitos: o suficiente para correlacionar
 * uma conversa no suporte, insuficiente para identificar ou discar.
 */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  if (digits.length < 6) {
    return '*'.repeat(raw.length);
  }

  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/** `Joao Silva` -> `J*** S***`: preserva iniciais e numero de termos. */
export function maskName(raw: string): string {
  const parts = raw.split(/\s+/).filter((part) => part.length > 0);

  if (parts.length === 0) {
    return raw;
  }

  return parts
    .map((part) => (part.length <= 1 ? '*' : `${part.charAt(0)}${'*'.repeat(3)}`))
    .join(' ');
}

/** `joao.silva@dominio.com` -> `j***@dominio.com`: o dominio ajuda no debug. */
export function maskEmail(raw: string): string {
  const separator = raw.lastIndexOf('@');

  if (separator <= 0) {
    return '***';
  }

  return `${raw.charAt(0)}***${raw.slice(separator)}`;
}

function maskObject(
  source: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    masked[key] = maskProperty(key, value, depth, seen);
  }

  return masked;
}

function maskProperty(
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  const normalized = key.toLowerCase();

  if (SECRET_KEYS.has(normalized)) {
    return '[redacted]';
  }

  if (REDACTED_KEYS.has(normalized)) {
    return redact(value);
  }

  // Chaves sensiveis aceitam numero (um telefone pode chegar como number no
  // JSON), entao o valor e normalizado para string antes de mascarar.
  if (isScalar(value)) {
    if (PHONE_KEYS.has(normalized)) {
      return maskPhone(String(value));
    }

    if (NAME_KEYS.has(normalized)) {
      return maskName(String(value));
    }

    if (EMAIL_KEYS.has(normalized)) {
      return maskEmail(String(value));
    }
  }

  return maskNode(value, depth + 1, seen);
}

function maskNode(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return maskText(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }

  // Payload externo pode conter ciclo; sem esta guarda o logger derruba o processo.
  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskText(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskNode(item, depth + 1, seen));
  }

  return maskObject(value as Record<string, unknown>, depth, seen);
}

/**
 * O corpo de uma mensagem de WhatsApp e PII por natureza — pode conter
 * qualquer coisa que o usuario digitou. Preserva-se apenas o tamanho, que
 * costuma bastar para diagnosticar truncamento ou payload vazio.
 */
function redact(value: unknown): string {
  return typeof value === 'string'
    ? `[redacted:${String(value.length)} chars]`
    : '[redacted]';
}

function isScalar(value: unknown): value is string | number | bigint {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
  );
}
