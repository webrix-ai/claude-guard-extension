/**
 * Claude Guard — built-in redaction guards.
 *
 * Ported from Willow's runtime redaction guards (regex checks only; LLM and
 * model-backed checks are not available inside a browser extension). Each
 * guard groups related checks. A check carries a certainty score (1–10) that
 * the extension compares against a user-configurable minimum, and a
 * replacement label that is written into the page in place of the match.
 *
 * Guards and individual checks can be toggled from the popup or enforced via
 * managed policy. Check ids follow Willow's `regex-<slugified-name>` format so
 * policies can reference them stably.
 *
 * Loaded before lib/redactor.js in the isolated world and in the popup; also a
 * CommonJS module for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClaudeGuardGuards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function check(name, certainty, pattern, replacement, extra) {
    var c = {
      id: 'regex-' + slugify(name),
      name: name,
      certainty: certainty,
      pattern: pattern,
      replacement: replacement
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) c[k] = extra[k];
    return c;
  }

  // Extension-only precision filter for card checks: reject numbers that fail
  // the Luhn checksum or are a single repeated digit.
  function luhn(candidate) {
    var digits = String(candidate).replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    if (/^(\d)\1+$/.test(digits)) return false;
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = digits.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  var CARD = { validate: luhn };

  var GUARDS = [
    {
      id: 'secrets',
      name: 'API Keys & Secrets',
      description: 'API keys, tokens, passwords, private keys, connection strings and other credentials.',
      defaultEnabled: true,
      checks: [
        check('Stripe / Platform API Key', 10, '(?:sk|pk)[-_](?:live|test|prod)[-_][A-Za-z0-9]{20,}', '[REDACTED-API-KEY]'),
        check('GitHub Token', 10, '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}', '[REDACTED-GITHUB-TOKEN]'),
        check('GitHub PAT', 10, 'github_pat_[A-Za-z0-9_]{22,}', '[REDACTED-GITHUB-PAT]'),
        check('GitLab Token', 10, 'glpat-[A-Za-z0-9\\-_]{20,}', '[REDACTED-GITLAB-TOKEN]'),
        check('AWS Access Key ID', 10, 'AKIA[0-9A-Z]{16}', '[REDACTED-AWS-ACCESS-KEY]'),
        check('AWS Secret Access Key', 10, '(?:aws_secret_access_key|secret_access_key|aws_secret)["\'\\s:=]+[A-Za-z0-9/+=]{40}', '[REDACTED-AWS-SECRET-KEY]'),
        check('Google API Key', 10, 'AIza[0-9A-Za-z\\-_]{35}', '[REDACTED-GOOGLE-API-KEY]'),
        check('Google OAuth Client Secret', 9, '(?:client_secret)["\'\\s:=]+[A-Za-z0-9\\-_]{24,}', '[REDACTED-OAUTH-SECRET]'),
        check('Azure Storage Connection String', 10, 'DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{44,}', '[REDACTED-AZURE-CONNECTION-STRING]'),
        check('DigitalOcean Token', 10, 'dop_v1_[a-f0-9]{64}', '[REDACTED-DO-TOKEN]'),
        check('OpenAI API Key', 10, 'sk-proj-[A-Za-z0-9\\-_]{40,}', '[REDACTED-OPENAI-KEY]'),
        check('Anthropic API Key', 10, 'sk-ant-[A-Za-z0-9\\-_]{20,}', '[REDACTED-ANTHROPIC-KEY]'),
        check('HuggingFace Token', 10, 'hf_[A-Za-z0-9]{34,}', '[REDACTED-HUGGINGFACE-TOKEN]'),
        check('Cohere API Key', 10, 'co-[A-Za-z0-9]{40,}', '[REDACTED-COHERE-KEY]'),
        check('Replicate API Token', 9, 'r8_[A-Za-z0-9]{36,}', '[REDACTED-REPLICATE-TOKEN]'),
        check('Slack Token', 10, 'xox[bpras]-[A-Za-z0-9-]{10,}', '[REDACTED-SLACK-TOKEN]'),
        check('Slack Webhook URL', 10, 'https://hooks\\.slack\\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+', '[REDACTED-SLACK-WEBHOOK]'),
        check('Twilio Account SID', 6, 'AC[0-9a-f]{32}', '[REDACTED-TWILIO-SID]'),
        check('SendGrid API Key', 6, 'SG\\.[A-Za-z0-9\\-_]{22,}\\.[A-Za-z0-9\\-_]{22,}', '[REDACTED-SENDGRID-KEY]'),
        check('Mailgun API Key', 10, 'key-[0-9a-zA-Z]{32}', '[REDACTED-MAILGUN-KEY]'),
        check('Mailchimp API Key', 9, '[a-f0-9]{32}-us\\d{1,2}', '[REDACTED-MAILCHIMP-KEY]'),
        check('Telegram Bot Token', 9, '\\d{8,10}:[A-Za-z0-9_-]{35}', '[REDACTED-TELEGRAM-TOKEN]'),
        check('Discord Bot Token', 9, '[MN][A-Za-z\\d]{23,}\\.[\\w-]{6}\\.[\\w-]{27,}', '[REDACTED-DISCORD-TOKEN]'),
        check('Shopify Access Token', 10, 'shpat_[a-fA-F0-9]{32}', '[REDACTED-SHOPIFY-TOKEN]'),
        check('Shopify Shared Secret', 10, 'shpss_[a-fA-F0-9]{32}', '[REDACTED-SHOPIFY-SECRET]'),
        check('Square Access Token', 10, 'sq0[a-z]{3}-[A-Za-z0-9\\-_]{22,}', '[REDACTED-SQUARE-TOKEN]'),
        check('NPM Token', 10, 'npm_[A-Za-z0-9]{36}', '[REDACTED-NPM-TOKEN]'),
        check('PyPI Token', 10, 'pypi-[A-Za-z0-9]{16,}', '[REDACTED-PYPI-TOKEN]'),
        check('Hashicorp Vault Token', 10, 'hvs\\.[A-Za-z0-9]{24,}', '[REDACTED-VAULT-TOKEN]'),
        check('Doppler Token', 10, 'dp\\.st\\.[A-Za-z0-9_-]{40,}', '[REDACTED-DOPPLER-TOKEN]'),
        check('Sentry DSN', 9, 'https://[a-f0-9]{32}@[^\\s]+\\.ingest\\.sentry\\.io/\\d+', '[REDACTED-SENTRY-DSN]'),
        check('Linear API Key', 9, 'lin_api_[A-Za-z0-9]{40,}', '[REDACTED-LINEAR-KEY]'),
        check('Private Key Header', 10, '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----', '[REDACTED-PRIVATE-KEY]'),
        check('JWT Token', 8, 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', '[REDACTED-JWT]'),
        check('Database Connection String', 9, '(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqp)://[^\\s:]+:[^\\s@]+@[^\\s]+', '[REDACTED-DB-CONNECTION]'),
        check('Password in Config', 8, '(?<![?&])(?:password|passwd|pwd)["\'\\s:=]+[^\\s"\']{8,}', '[REDACTED-PASSWORD]'),
        check('Generic API Key Assignment', 7, '(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)["\'\\s:=]+[A-Za-z0-9\\-_.]{20,}', '[REDACTED-API-KEY]'),
        check('Generic Secret Assignment', 7, '(?:secret|token|credential)["\'\\s:=]+[A-Za-z0-9\\-_.]{20,}', '[REDACTED-SECRET]'),
        check('Stripe Restricted Key', 10, 'rk_(?:live|test)_[A-Za-z0-9]{20,}', '[REDACTED-API-KEY]'),
        check('Stripe Webhook Secret', 10, 'whsec_[A-Za-z0-9]{20,}', '[REDACTED-WEBHOOK-SECRET]'),
        check('OpenAI Legacy Key', 9, 'sk-(?!proj-|ant-|live[_-]|test[_-]|prod[_-])[A-Za-z0-9]{32,}', '[REDACTED-OPENAI-KEY]'),
        check('URL Embedded Credentials', 9, 'https?://[^\\s:"\']+:[^\\s@"\']+@[^\\s"\']+', '[REDACTED-URL-CREDENTIALS]'),
        check('Terraform Cloud Token', 9, 'atlasv1\\.[A-Za-z0-9\\-_]{50,}', '[REDACTED-TERRAFORM-TOKEN]'),
        check('Env Var Secret Assignment', 8, '(?:SECRET|PRIVATE|AUTH|ACCESS|ENCRYPTION|SIGNING|SESSION|MASTER)[_-]?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\\s*[=:]\\s*[A-Za-z0-9\\-_./+=]{20,}', '[REDACTED-SECRET]'),
        check('AWS AppSync GraphQL Key', 10, 'da2-[a-z0-9]{26}', '[REDACTED-APPSYNC-KEY]'),
        check('Alibaba Cloud Access Key', 10, 'LTAI[a-zA-Z0-9]{17,21}', '[REDACTED-ALIBABA-KEY]'),
        check('Databricks Token', 10, 'dapi[a-f0-9]{32}', '[REDACTED-DATABRICKS-TOKEN]'),
        check('Cloudinary URL', 10, 'cloudinary://[0-9]+:[A-Za-z0-9\\-_.]+@[A-Za-z0-9\\-_.]+', '[REDACTED-CLOUDINARY-URL]'),
        check('Facebook Access Token', 9, 'EAACEdEose0cBA[0-9A-Za-z]+', '[REDACTED-FACEBOOK-TOKEN]'),
        check('Google OAuth Access Token', 9, 'ya29\\.[0-9A-Za-z\\-_]+', '[REDACTED-GOOGLE-OAUTH-TOKEN]'),
        check('Discord Webhook URL', 10, 'https://discord(?:app)?\\.com/api/webhooks/[0-9]+/[A-Za-z0-9\\-]+', '[REDACTED-DISCORD-WEBHOOK]'),
        check('Dropbox Access Token', 10, 'sl\\.[A-Za-z0-9\\-_]{130,}', '[REDACTED-DROPBOX-TOKEN]'),
        check('Flutterwave Secret Key', 10, 'FLWSECK-[0-9a-z]{32}-X', '[REDACTED-FLUTTERWAVE-KEY]'),
        check('Razorpay API Key', 10, 'rzp_\\w{2,6}_\\w{10,20}', '[REDACTED-RAZORPAY-KEY]'),
        check('Adafruit IO Key', 9, 'aio_[a-zA-Z0-9]{28}', '[REDACTED-ADAFRUIT-KEY]'),
        check('AWS MWS Key', 10, 'amzn\\.mws\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '[REDACTED-AWS-MWS-KEY]'),
        check('Braintree Access Token', 10, 'access_token\\$production\\$[0-9a-z]{16}\\$[0-9a-f]{32}', '[REDACTED-BRAINTREE-TOKEN]')
      ]
    },
    {
      id: 'email',
      name: 'Email Addresses',
      description: 'Email addresses and mailto links.',
      defaultEnabled: false,
      checks: [
        check('Email Address', 10, '\\b[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}\\b', '[REDACTED-EMAIL]'),
        check('Mailto Link', 9, 'mailto:[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}', '[REDACTED-EMAIL]')
      ]
    },
    {
      id: 'phone',
      name: 'Phone Numbers',
      description: 'US, UK and international phone numbers.',
      defaultEnabled: false,
      checks: [
        check('US Phone Number', 6, '\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b', '[REDACTED-PHONE]'),
        check('US Phone with Area Code Parens', 8, '\\(\\d{3}\\)\\s?\\d{3}[-.\\s]\\d{4}', '[REDACTED-PHONE]'),
        check('US Phone with Country Code', 7, '\\b\\+?1[-.\\s]\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b', '[REDACTED-PHONE]'),
        check('International Phone Number', 7, '\\+\\d{1,3}[-.\\s]\\(?\\d{1,4}\\)?(?:[-.\\s]\\d{1,4}){2,4}\\b', '[REDACTED-PHONE]'),
        check('UK Phone Number', 6, '\\b0\\d{2,4}[-.\\s]\\d{3,4}[-.\\s]\\d{3,4}\\b', '[REDACTED-PHONE]')
      ]
    },
    {
      id: 'ssn',
      name: 'Social Security Numbers',
      description: 'US Social Security Numbers, with or without a label.',
      defaultEnabled: true,
      checks: [
        check('Social Security Number', 5, '(?<![0-9])\\d{3}[-.\\s]+\\d{2}[-.\\s]+\\d{4}(?![0-9])', '[REDACTED-SSN]'),
        check('SSN with Label', 8, '\\b(?:SSN|social security)\\b[^0-9]{1,30}(?:\\d{3}[-.\\s]+\\d{2}[-.\\s]+\\d{4}|\\d{9})(?![0-9])', '[REDACTED-SSN]')
      ]
    },
    {
      id: 'credit-card',
      name: 'Credit Card Numbers',
      description: 'Visa, Mastercard, Amex, Discover, JCB and UnionPay card numbers (Luhn-validated).',
      defaultEnabled: true,
      checks: [
        check('Credit Card 16-Digit', 7, '\\b\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('Amex 15-Digit', 8, '\\b3[47]\\d{2}[ -]?\\d{6}[ -]?\\d{5}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('Visa Prefix', 8, '\\b4\\d{3}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('Mastercard Prefix', 8, '\\b5[1-5]\\d{2}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('Discover Prefix', 8, '\\b6(?:011|5\\d{2})[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('JCB', 8, '\\b35[2-8]\\d[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD),
        check('UnionPay', 8, '\\b62\\d{2}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b', '[REDACTED-CREDIT-CARD]', CARD)
      ]
    },
    {
      id: 'ip-address',
      name: 'IP & MAC Addresses',
      description: 'IPv4, IPv6, CIDR ranges and MAC addresses.',
      defaultEnabled: false,
      checks: [
        check('IPv4 Address', 9, '\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b', '[REDACTED-IP-ADDRESS]'),
        check('IPv4 CIDR Notation', 8, '\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)/\\d{1,2}\\b', '[REDACTED-IP-ADDRESS]'),
        check('IPv6 Full', 8, '(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}', '[REDACTED-IP-ADDRESS]'),
        check('IPv6 Compressed', 8, '(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}', '[REDACTED-IP-ADDRESS]'),
        check('MAC Address', 7, '(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}', '[REDACTED-MAC-ADDRESS]')
      ]
    },
    {
      id: 'financial',
      name: 'Financial Data',
      description: 'IBANs, routing numbers, SWIFT/BIC codes and labelled bank account numbers.',
      defaultEnabled: true,
      checks: [
        check('IBAN', 9, '\\b[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}[A-Z0-9]{0,16}\\b', '[REDACTED-IBAN]'),
        check('ABA Routing Number with Label', 8, '(?:routing|Routing|ROUTING|ABA)[:\\s#]*\\d{9}\\b', '[REDACTED-ROUTING]'),
        check('SWIFT/BIC Code', 8, '(?:[Ss][Ww][Ii][Ff][Tt](?:\\s*[Cc][Oo][Dd][Ee])?|[Bb][Ii][Cc](?:\\s*[Cc][Oo][Dd][Ee])?)[\\s:/=#-]*[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?', '[REDACTED-SWIFT]'),
        check('Bank Account with Label', 8, '(?:account|Account|ACCOUNT|acct|Acct|ACCT)[:\\s#]*\\d{8,17}\\b', '[REDACTED-ACCOUNT]')
      ]
    },
    {
      id: 'dob',
      name: 'Dates of Birth',
      description: 'Labelled dates of birth in numeric or ISO formats.',
      defaultEnabled: false,
      checks: [
        check('DOB with Label', 9, '(?:DOB|[Dd][Aa][Tt][Ee]\\s+[Oo][Ff]\\s+[Bb][Ii][Rr][Tt][Hh]|[Bb][Oo][Rr][Nn]\\s+[Oo][Nn]|[Bb][Ii][Rr][Tt][Hh][Dd][Aa][Yy]|[Bb][Ii][Rr][Tt][Hh][Dd][Aa][Tt][Ee])[:\\s]+\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}', '[REDACTED-DOB]'),
        check('DOB ISO with Label', 8, '(?:DOB|[Dd][Aa][Tt][Ee]\\s+[Oo][Ff]\\s+[Bb][Ii][Rr][Tt][Hh]|[Bb][Oo][Rr][Nn]\\s+[Oo][Nn]|[Bb][Ii][Rr][Tt][Hh][Dd][Aa][Yy]|[Bb][Ii][Rr][Tt][Hh][Dd][Aa][Tt][Ee])[:\\s]+\\d{4}[/\\-.]\\d{1,2}[/\\-.]\\d{1,2}', '[REDACTED-DOB]')
      ]
    },
    {
      id: 'government-id',
      name: 'Government-Issued IDs',
      description: 'Passport numbers, driver licence numbers, UK NINs and Canadian SINs.',
      defaultEnabled: true,
      checks: [
        check('US Passport Number', 8, '(?:passport|Passport|PASSPORT)[:\\s#]*[A-Z]?\\d{8,9}\\b', '[REDACTED-PASSPORT]'),
        check('Driver License with Label', 6, '(?:[Dd][Rr][Ii][Vv][Ee][Rr]\'?[Ss]?\\s*[Ll][Ii][Cc][Ee][Nn][SsCc][Ee]|DL|dl)[:\\s#]*[A-Z0-9]{5,15}\\b', '[REDACTED-DL]'),
        check('UK NIN', 8, '\\b[A-CEGHJ-PR-TW-Za-ceghj-pr-tw-z]{2}\\d{6}[A-Da-d]\\b', '[REDACTED-NIN]'),
        check('Canadian SIN', 8, '(?:SIN|Sin)[:\\s#]*\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{3}', '[REDACTED-SIN]')
      ]
    },
    {
      id: 'address',
      name: 'Home Addresses',
      description: 'Street addresses, PO boxes, city/state/ZIP, UK postcodes and GPS coordinates.',
      defaultEnabled: false,
      checks: [
        check('US Street Address', 7, '\\b\\d{1,5}\\s[A-Z][a-z]+(?:\\s[A-Z][a-z]+)*\\s(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Way|Pl|Place)\\b(?:[,.\\s]+(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?', '[REDACTED-ADDRESS]'),
        check('PO Box', 7, '(?:P\\.?\\s?O\\.?\\s?Box|Post\\s?Office\\s?Box)\\s+\\d+', '[REDACTED-ADDRESS]'),
        check('City State ZIP', 7, '\\b[A-Z][a-z]+(?:\\s[A-Z][a-z]+)*,\\s*[A-Z]{2}\\.?\\s+\\d{5}(?:-\\d{4})?\\b', '[REDACTED-ADDRESS]'),
        check('US ZIP+4', 6, '\\b\\d{5}-\\d{4}\\b', '[REDACTED-ZIP]'),
        check('UK Postcode', 6, '\\b[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}\\b', '[REDACTED-POSTCODE]'),
        check('Address with Label', 8, '(?:[Hh]ome\\s+[Aa]ddress|[Mm]ailing\\s+[Aa]ddress|[Ss]treet\\s+[Aa]ddress|[Rr]esidence)[:\\s]+[^\\n,]{5,80}(?:,[^\\n,]{2,40}){0,3}', '[REDACTED-ADDRESS]'),
        check('GPS Coordinates with Label', 7, '(?:lat(?:itude)?|lng|lon(?:gitude)?|geo(?:location)?|coords?(?:inates)?)["\'\\s:=]+[-+]?\\d{1,3}\\.\\d{4,}', '[REDACTED-COORDINATES]')
      ]
    }
  ];

  var BY_ID = {};
  GUARDS.forEach(function (g) { BY_ID[g.id] = g; });

  /** Default minimum certainty: checks rated below this are ignored. */
  var DEFAULT_MIN_CERTAINTY = 6;

  function getGuard(id) { return BY_ID[id] || null; }

  function findCheck(guard, checkId) {
    for (var i = 0; i < guard.checks.length; i++) if (guard.checks[i].id === checkId) return guard.checks[i];
    return null;
  }

  return {
    GUARDS: GUARDS,
    DEFAULT_MIN_CERTAINTY: DEFAULT_MIN_CERTAINTY,
    getGuard: getGuard,
    findCheck: findCheck,
    luhn: luhn,
    slugify: slugify
  };
});
