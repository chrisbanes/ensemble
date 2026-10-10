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
/** Three grouped questions as the design draws them: single choice with a recommendation, a bounded multiple choice, and free text. */
export const guideForm: QuestionForm = {
  version: 1,
  questions: [
    {
      id: "audience",
      kind: "single-choice",
      label: "Who should the guide address?",
      required: true,
      customAllowed: true,
      options: [
        {
          id: "members",
          label: "Every new member",
          description: "Daily use, with separate owner setup.",
        },
        {
          id: "owners",
          label: "Workspace owners",
          description: "Focus on inviting people and setup.",
        },
      ],
      recommended: ["members"],
    },
    {
      id: "sections",
      kind: "multiple-choice",
      label: "Which sections belong in the guide?",
      required: true,
      customAllowed: false,
      options: [
        {
          id: "actions",
          label: "Find everyday actions",
          description: "Searching and keyboard shortcuts",
        },
        {
          id: "invite",
          label: "Invite teammates",
          description: "Owner checklist",
        },
        {
          id: "defaults",
          label: "Workspace defaults",
          description: "Initial settings",
        },
      ],
      minSelections: 1,
      maxSelections: 2,
    },
    {
      id: "tone",
      kind: "free-text",
      label: "How should the opening sound?",
      required: true,
      maxLength: 240,
    },
  ],
};
/** One question with two options, for the single-question presentation. */
export const choiceForm: QuestionForm = {
  version: 1,
  questions: [
    {
      id: "choice",
      kind: "single-choice",
      label: "Choose the guide's audience",
      required: true,
      customAllowed: false,
      options: [
        {
          id: "members",
          label: "Every new member",
          description: "Separate owner setup.",
        },
        {
          id: "owners",
          label: "Team owners",
          description: "Keep the setup guide.",
        },
      ],
      recommended: ["members"],
    },
  ],
};
