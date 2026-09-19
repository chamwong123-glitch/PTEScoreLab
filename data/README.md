# Question table

`questions.json` holds every question added after the app's built-in bank, one record per question. The app loads it when it opens and adds each record to its question type. If the file is missing or can't be read, the app still runs with the built-in questions.

## IDs

Every question — built-in or in this table — has an ID made of its question type's prefix and a four-digit number, e.g. `RP0001` for the first Reorder Paragraph question.

- Built-in questions hold the lowest numbers. New questions carry on from the last number used for that type (see the table below).
- **IDs are permanent.** Never renumber, reuse or delete-and-recycle an ID: saved practice history refers to it.
- A record whose ID prefix isn't recognised, duplicates another ID, or lacks a required field is skipped (a warning appears in the browser console).

| Question type | Prefix | Built-in IDs | Next free ID |
|---|---|---|---|
| Personal Introduction | PI | PI0001 | PI0002 |
| Read Aloud | RA | RA0001–RA0002 | RA0003 |
| Repeat Sentence | RS | RS0001–RS0005 | RS0006 |
| Describe Image | DI | DI0001–DI0002 | DI0003 |
| Re-tell Lecture | RL | RL0001–RL0002 | RL0003 |
| Answer Short Question | ASQ | ASQ0001–ASQ0008 | ASQ0009 |
| Summarize Group Discussion | SGD | SGD0001–SGD0002 | SGD0003 |
| Respond to a Situation | RTS | RTS0001–RTS0003 | RTS0004 |
| Summarize Written Text | SWT | SWT0001–SWT0002 | SWT0003 |
| Write Essay | WE | WE0001–WE0002 | WE0003 |
| Reading & Writing: Fill in the Blanks (dropdown) | RWFIB | RWFIB0001–RWFIB0002 | RWFIB0003 |
| Reading: Multiple Choice, Multiple Answers | MCMAR | MCMAR0001–MCMAR0002 | MCMAR0003 |
| Reorder Paragraph | RP | RP0001–RP0002 | RP0003 |
| Reading: Fill in the Blanks (drag and drop) | RFIB | RFIB0001–RFIB0002 | RFIB0003 |
| Reading: Multiple Choice, Single Answer | MCSAR | MCSAR0001–MCSAR0002 | MCSAR0003 |
| Summarize Spoken Text | SST | SST0001–SST0002 | SST0003 |
| Listening: Multiple Choice, Multiple Answers | MCMAL | MCMAL0001–MCMAL0002 | MCMAL0003 |
| Highlight Correct Summary | HCS | HCS0001–HCS0002 | HCS0003 |
| Listening: Fill in the Blanks | LFIB | LFIB0001–LFIB0002 | LFIB0003 |
| Listening: Multiple Choice, Single Answer | MCSAL | MCSAL0001–MCSAL0002 | MCSAL0003 |
| Select Missing Word | SMW | SMW0001–SMW0003 | SMW0004 |
| Highlight Incorrect Words | HIW | HIW0001–HIW0002 | HIW0003 |
| Write from Dictation | WFD | WFD0001–WFD0006 | WFD0007 |

Update the **Next free ID** column whenever questions are added.

## Record fields

Records use the same fields as the built-in questions. **Audio is not stored as sound files**: the app reads the text aloud with the device's British voices, so a listening question's script is its audio, and the transcript shown after answering is built from the same text.

| Type | Required fields | Notes |
|---|---|---|
| PI | `text`, `keys` | `text` = the prompt; `keys` = points to cover |
| RA | `text`, `focus` | `focus` = words worth practising |
| RS | `text` | the sentence spoken |
| DI | `fig`, `caption`, `keys`, `model` | `fig` = the chart as inline SVG |
| RL | `voice`, `text`, `keys`, `model` | `voice` = `"f"` or `"m"`; `text` = lecture script |
| ASQ | `q`, `a` | `a` = list of accepted answers |
| SGD | `title`, `turns`, `keys`, `model` | `turns` = `[{ "who", "sex": "f"/"m", "text" }]`, three speakers |
| RTS | `text`, `keys`, `model` | `text` = the situation |
| SWT | `title`, `passage`, `model` | paragraphs separated by a blank line (`\n\n`) |
| WE | `prompt`, `plan` | `plan` = list of planning hints |
| RWFIB | `title`, `parts`, `gaps`, `why` | text is `parts[0] gap parts[1] gap …`; `gaps` = `[{ "o": options, "a": answer }]`; `why` per gap |
| MCMAR | `passage`, `q`, `o`, `why`, `a` | `a` = list of correct option indexes (from 0); `why` per option |
| RP | `order`, `why` | `order` = paragraphs in the correct order; `why` per paragraph |
| RFIB | `title`, `parts`, `ans`, `bank`, `why` | `bank` = word bank including distractors |
| MCSAR | `passage`, `q`, `o`, `why`, `a` | `a` = the correct option index |
| SST | `voice`, `title`, `text`, `keys`, `model` | |
| MCMAL | `text`, `q`, `o`, `a` | `text` = audio script |
| HCS | `text`, `q`, `o`, `a` | |
| LFIB | `title`, `parts`, `ans` | audio = parts joined with the answers |
| MCSAL | `text`, `q`, `o`, `a` | |
| SMW | `text`, `o`, `a` | `text` = audio up to the missing ending |
| HIW | `spoken`, `shown`, `errors` | `errors` = word positions (from 0) where `shown` differs |
| WFD | `text` | |

Timings, lengths and marking must follow the documents in [`../reference/`](../reference/README.md).

## Traditional Chinese

Each record can carry a `zh` object mapping each English string to its Traditional Chinese translation:

```json
{
  "id": "RP0003",
  "order": ["First paragraph …", "Second paragraph …"],
  "why": ["The opener. …", "…"],
  "zh": {
    "First paragraph …": "第一段……",
    "First paragraph … — The opener. …": "第一段……——開頭句。……"
  }
}
```

Keys must match the text as the app shows it. For gapped passages, that means `parts` joined with `____`. For Reorder Paragraph explanations, it means the paragraph, then ` — `, then the explanation. For speaker turns, it means `Name: text`. For Write from Dictation, it means the sentence in lower case with punctuation removed. Anything without a translation simply shows no Chinese.
