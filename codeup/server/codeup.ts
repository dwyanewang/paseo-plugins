import { defineForgeServerProvider } from "@getpaseo/plugin/server";
import { codeupDefinition } from "../shared/codeup-definition";
import { createCodeupService } from "./codeup-service";

export const codeupServerProvider = defineForgeServerProvider({
  definition: codeupDefinition,
  service: createCodeupService(),
});
