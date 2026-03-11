const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.blue}INFO${COLORS.reset}  ${msg}`, ...args);
  },
  success(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.green}OK${COLORS.reset}    ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.red}ERROR${COLORS.reset} ${msg}`, ...args);
  },
  trade(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.magenta}TRADE${COLORS.reset} ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (process.env.DEBUG) {
      console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.cyan}DEBUG${COLORS.reset} ${msg}`, ...args);
    }
  },
};
