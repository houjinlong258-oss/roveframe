const userAgent = process.env.npm_config_user_agent ?? '';

if (!userAgent.startsWith('pnpm/')) {
  console.error('RoveFrame requires pnpm. Run dependency and lifecycle commands with pnpm.');
  process.exit(1);
}
