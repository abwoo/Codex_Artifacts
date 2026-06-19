# Prompt Lab

## Control Surface

Use the slider to generate a compact prompt variant.

<div class="control-lab">
  <label>Detail level <input type="range" min="1" max="5" value="3" data-artifact-control data-target="#promptOutput"></label>
  <textarea id="promptOutput" data-template="Create a Codex artifact with detail level {{level}}. Include concise status, risks, next actions, and verification evidence."></textarea>
</div>

## Notes

- Keep the generated prompt specific to the current session.
- Include only the context needed for the next useful action.
- Copy the prompt from the toolbar when ready.
