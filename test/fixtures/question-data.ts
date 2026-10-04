import type { QuestionForm } from "../../src/core/question-forms.js";
export const mixedForm: QuestionForm = {
  version: 1,
  questions: [
    {
      id: "notes",
      kind: "free-text",
      label: "Explain",
      required: true,
      minLength: 2,
      maxLength: 16000,
    },
    {
      id: "color",
      kind: "single-choice",
      label: "Color",
      required: true,
      customAllowed: true,
      options: [
        { id: "red", label: "Red", description: "Literal description" },
        { id: "blue", label: "Blue" },
      ],
      recommended: ["blue"],
      preselected: ["red"],
    },
    {
      id: "places",
      kind: "multiple-choice",
      label: "Places",
      required: true,
      customAllowed: true,
      options: [
        { id: "home", label: "Home" },
        { id: "work", label: "Work" },
      ],
      minSelections: 1,
      maxSelections: 2,
    },
    { id: "optional", kind: "free-text", label: "Optional", required: false },
  ],
};
export const mixedAnswers = {
  notes: { optionIds: [], text: "Exact text" },
  color: { optionIds: ["blue"], text: "" },
  places: { optionIds: ["home"], text: "Other exact place" },
  optional: { optionIds: [], text: "" },
};
