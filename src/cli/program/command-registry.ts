import type { Command } from "commander";
import { getPrimaryCommand } from "../argv.js";
import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";
import type { ProgramContext } from "./context.js";

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

type CoreCliEntry = {
  name: string;
  description: string;
  register: (params: CommandRegisterParams) => Promise<void> | void;
};

const BOOTSTRAP_ENTRY: CoreCliEntry = {
  name: "bootstrap",
  description: "Bootstrap DenchClaw + OpenClaw and launch the web UI",
  register: async ({ program }) => {
    const mod = await import("./register.bootstrap.js");
    mod.registerBootstrapCommand(program);
  },
};

function registerLazyBootstrap(program: Command, ctx: ProgramContext) {
  const placeholder = program
    .command(BOOTSTRAP_ENTRY.name)
    .description(BOOTSTRAP_ENTRY.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    removeCommandByName(program, BOOTSTRAP_ENTRY.name);
    await BOOTSTRAP_ENTRY.register({ program, ctx, argv: process.argv });
    await reparseProgramFromActionArgs(program, actionArgs);
  });
}

export function getCoreCliCommandNames(): string[] {
  return [BOOTSTRAP_ENTRY.name];
}

export function getCoreCliCommandsWithSubcommands(): string[] {
  return [];
}

export async function registerCoreCliByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
  argv: string[] = process.argv,
): Promise<boolean> {
  void argv;
  if (name !== BOOTSTRAP_ENTRY.name) {
    return false;
  }
  removeCommandByName(program, BOOTSTRAP_ENTRY.name);
  await BOOTSTRAP_ENTRY.register({ program, ctx, argv });
  return true;
}

export function registerCoreCliCommands(program: Command, ctx: ProgramContext, argv: string[]) {
  const primary = getPrimaryCommand(argv);
  if (primary && primary !== BOOTSTRAP_ENTRY.name) {
    return;
  }
  registerLazyBootstrap(program, ctx);
}

export function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  registerCoreCliCommands(program, ctx, argv);
}
