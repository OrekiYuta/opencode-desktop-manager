import { Plugin } from "@opencode/plugin"
import fusionPlugin from "./github-copilot-fusion/index.js"
import { UsageRpc } from "./github-copilot-usage/rpc.js"
import { UsageService } from "./github-copilot-usage/service.js"

export default Plugin.define({
  id: fusionPlugin.id,
  async setup(ctx) {
    const usage = new UsageService(ctx.integration)
    await ctx.rpc.register(UsageRpc, {
      get: async (input) => usage.get(input as { refresh: boolean }),
    })
    return fusionPlugin.setup(ctx)
  },
})
