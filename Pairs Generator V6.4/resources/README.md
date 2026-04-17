# Resources Directory

This directory contains consolidated keyword lists and stopword files used by the market matching and categorization workflow.

## Contents

- **Category Keywords (`*.txt` except stopwords)**:
  - Each file (e.g., `Sports.txt`, `Crypto.txt`) contains keywords used to classify markets into specific fee categories.
  - Used by `v1/categorize_markets.py` and `v1/match_sports.py`.
  - Format: One keyword or phrase per line.

- **Stop Words (`EN-Stopwords.txt`)**:
  - Contains common English words to be filtered out during title normalization.
  - Used by `v1/normalize_markets.py`.

- **Politicians (`politicians.txt`)**:
  - List of political figures used for specific categorization or normalization tasks.

## Usage

The Python scripts in the `v1/` directory are configured to look for these files in this directory relative to their own location. If you add new categories, ensure they are also added to the `CATEGORY_FILES` list in `v1/categorize_markets.py`.
