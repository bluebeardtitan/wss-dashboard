# Search guide

The search box matches either plain text or logical expressions. Type normally for text matching; switch to expression syntax when you need to filter on values.

## Plain text

Case-insensitive substring match against card names, field names, and field values. `pump` matches cards named Pump House and any card whose notes contain "pumping".

A query stays plain text unless it contains a field reference or a comparison operator, so searches like `done & wip` find that literal text rather than erroring.

## Expressions

Any query containing `field:"..."` or a comparison operator is compiled as an expression and tested against every visible card. Only cards where it evaluates to exactly `true` are shown.

### Referring to fields

| Form | Example |
| --- | --- |
| Exact reference | `field:"Demand(MLD)" > 400` |
| Single quotes | `field:'Status' == "Completed"` |
| Bare word | `Status == "Completed"` |

- `field:"..."` is the reliable form. It handles spaces, brackets, and punctuation: `field:"No. of Villages" < 2`
- Names match case-insensitively: `field:"district"` finds "District".
- Bare words resolve against field names the same way, but only when they have no spaces or special characters.
- `name` is the card's own name: `name ~= "^Kerala"`.

### Operators

| Operator | Meaning |
| --- | --- |
| `==` `!=` | Equal / not equal (strict: `"Done"` ≠ `"done"`, `400` ≠ `"400"`) |
| `>` `>=` `<` `<=` | Numeric comparison — both sides must be numbers |
| `~=` | Regular expression test: `value ~= "pattern"` |
| `and` `or` `not` | Boolean logic |
| `( )` | Grouping |
| `+` `-` `*` `/` `^` `mod` | Arithmetic |
| `if x then y else z` | Conditional value |
| `(a, b, c)` | Array literal |
| `x in (a, b)` | Membership (`not in` negates) |

### Functions

`abs` `ceil` `floor` `log` `log2` `log10` `max` `min` `round` `sqrt`

Two exist specifically for data checking:

- `exists(field:"Notes")` — true when the field is present and not null.
- `empty(field:"Notes")` — true when missing, blank, or an empty array. Combine with `not`: `not empty(field:"Phone")`.

### Values and types

- Values that look like numbers are treated as numbers when read from fields: a stored `"400"` equals the literal `400`, and works with `>`, `>=`, and other ordering comparisons.
- Everything else is a string. Equality is strict, so `Status == "Completed"` only matches that exact capitalization.
- A comparison against a missing or blank field is false, not an error. Use `exists()` or `empty()` when you need to distinguish those cases.
- Ordering comparisons (`>` `<` and friends) reject text: `Status > "A"` matches nothing because "Completed" is not a number. Use `==`, `in`, or `~=` for text.

## Examples

```
field:"Demand(MLD)" > 400 and field:"No. of Villages" < 2
Status == "Completed" or Status == "Commissioned"
field:"District" in ("North", "South")
not empty(field:"Notes")
name ~= "^WSS"
field:"Cost" / field:"Villages" > 50
if field:"Status" == "Done" then field:"Cost" < 500 else false
max(field:"Phase 1", field:"Phase 2") >= 3
```

## Matching a list of values

To find cards where a field equals any of several values, use `in` with unquoted numeric literals (stored values that look like numbers are read as numbers):

```
field:"Scheme Code" in (11045, 20145, 45065)
```

If the codes may appear inside longer text (`PH-11045`) or mix types, test them as substrings instead:

```
field:"Scheme Code" ~= "11045|20145|45065"
```

Quoted literals fail with `in` for numeric fields: `in ("11045", ...)` compares text against the number 11045 and never matches.

## When a query is invalid

An expression that looks like an expression but fails to compile marks the search box red and appends "— invalid expression" to the results line. Nothing matches until the syntax is fixed. Runtime problems (for example a regex that never finishes) simply exclude that card instead of breaking the list.

## Where search applies

The active filter drives the card list, Select All while in selection mode, and the table generated from the Table modal — all three operate on the same matching set.
