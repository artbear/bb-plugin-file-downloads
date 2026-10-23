import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { downloadInputSchema, downloadOutputSchema } from "./shared";
import { createDownload } from "./download-service";

export const rpcContract = defineRpcContract({
  downloads_create: { input: downloadInputSchema, output: downloadOutputSchema },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    downloads_create: (input) => createDownload(bb.sdk, input),
  });
}
