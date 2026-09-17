import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "dure_qa_question",
    label: "Fixture question",
    description: "Request the isolated fixture reply from the connected client.",
    parameters: Type.Object({}),
    async execute(_id, _parameters, signal, _onUpdate, context) {
      const answer = await context.ui.input("Enter the fixture reply", { signal });
      return {
        content: [{ type: "text", text: answer ?? "Fixture question cancelled" }],
        details: {},
      };
    },
  });
}
