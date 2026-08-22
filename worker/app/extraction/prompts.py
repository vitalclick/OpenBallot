"""GPT-4o vision prompt for EC8A extraction.

The prompt is engineered to:
  * Force JSON-only output (`response_format={"type":"json_object"}`)
  * Return the exact field names our ExtractedEC8A model expects
  * Surface its own confidence per field so we can route low-confidence
    extractions to the human review queue
  * Refuse to invent data: when a field is illegible, emit null + low
    confidence rather than guess.

This prompt is versioned; each change bumps PROMPT_VERSION so we can
correlate extraction quality with the prompt revision over time.
"""

PROMPT_VERSION = "1.2.0"

EXTRACTION_PROMPT = """\
You are reviewing a photograph of a Nigerian INEC Form EC8A. The form
records the result for a single polling unit. Extract the structured
data into JSON. Return ONLY the JSON, no commentary.

If any field is illegible, return null for that value and a confidence
below 0.5 for that field. Never invent data. If the image is clearly not
an EC8A, return {"error": "not_an_ec8a"}.

Schema you must return:

{
  "pu_code": "<string, the polling unit code printed on the form>",
  "registered_voters": <integer>,
  "accredited_voters": <integer>,
  "candidate_votes": {
    "<party code in upper case>": <integer, the FIGURES column>,
    ...
  },
  "candidate_votes_words": {
    "<party code in upper case>": "<the WORDS column, transcribed verbatim>",
    ...
  },
  "total_valid_votes": <integer>,
  "rejected_ballots": <integer>,
  "total_votes_cast": <integer>,
  "presiding_officer_signed": <boolean - did the presiding officer sign?>,
  "agent_signatures_detected": <integer count of party agent signatures>,
  "official_stamp_present": <boolean - is the INEC official stamp present?>,
  "confidence": {
    "pu_code": <float 0-1>,
    "registered_voters": <float 0-1>,
    "accredited_voters": <float 0-1>,
    "candidate_votes": <float 0-1>,
    "total_valid_votes": <float 0-1>,
    "rejected_ballots": <float 0-1>,
    "total_votes_cast": <float 0-1>,
    "signatures": <float 0-1>
  }
}

Notes:
  - Party codes are usually three to four upper-case letters. Common
    Nigerian parties include APC, PDP, LP, NNPP, ADC, APGA, SDP.
  - The form records each party's votes TWICE: once in figures and once
    in words. Transcribe BOTH. Put the figures in candidate_votes and the
    words in candidate_votes_words, keyed by the same party code.
  - Transcribe the words column exactly as written, including apparent
    misspellings. Do NOT convert it to a number and do NOT correct it --
    the platform reconciles the two columns itself, and a "helpful"
    correction destroys the independence that makes the second reading
    worth having. If a party's words cell is blank, omit that key.
  - "Nil" or "None" in the words column means zero votes.
  - The bottom of the form has spaces for party agent signatures.
    Count how many are filled in (signed), not how many spaces exist.
  - The presiding officer signature is on a labelled line near the
    bottom.
  - The official INEC stamp is a round inked impression, typically blue
    or purple.
  - If the form is partially obscured (folded, blurred, glare), still
    attempt to extract what is legible and mark obscured fields with
    low confidence.
"""
