# Transaction Classification

Deep-dive on the classification pipeline in `sync-engine/classify.js`.

## Pipeline

```
Phase 0: Account-type-implied   — mortgage, auto_loan, student_loan, personal_loan, heloc, cd
Tier 1:  Merchant rules         — pattern match on description (e.g., "Zelle payment to" → Transfer)
Tier 2:  Model (cache or infer) — sign-prefixed DistilBERT v2 ([debit]/[credit] + full description)
Tier 3:  Bank category fallback — if model confidence < 0.70 and bank has a mappable category
```

Account-type-implied categories skip the model entirely — all transactions on a mortgage account are Mortgage by definition. For checking, savings, and credit card accounts, the model runs with a `[debit]`/`[credit]` sign prefix derived from the normalized transaction amount.

## Categories

**17 model-classified categories:** Restaurants, Groceries, Shopping, Transportation, Entertainment, Utilities, Subscription, Healthcare, Insurance, Mortgage, Rent, Travel, Education, Personal Care, Transfer, Income, Fees.

**6 account-type-implied categories:** Mortgage (mortgage accounts), Transportation (auto_loan), Education (student_loan), Transfer (personal_loan, heloc), Income (cd).

"Business" is not a transaction-level category — whether a transaction is a business expense depends on which account it's charged to, not the description. Account-level annotations are a separate layer.

**Transfer and Income are excluded from spending analysis** (`/brief-me`) by default — transfers are money movement between accounts, income is money coming in. Neither represents discretionary spending.

## Configuration

- **Merchant rules + bank category mappings:** `config/category-overrides.json`
- **Fine-tuned model:** `data/models/foliome-classifier-v2-onnx/`
- **Data validation:** `scripts/validate-data.js` checks account-type-implied classifications and model output

## Model Architecture

Sign-prefixed DistilBERT v2 — the model receives `[debit]` or `[credit]` prepended to the full transaction description. This disambiguates cases where the same merchant appears in both directions (e.g., a refund from a restaurant is Income, not Restaurants).

**Published on HuggingFace:**
- Model: `DoDataThings/distilbert-us-transaction-classifier-v2`
- Dataset: `DoDataThings/us-bank-transaction-categories-v2`

## Training

Synthetic training data (68k samples, 8 bank formats). Fine-tuning uses DistilBERT + LoRA. Training scripts are not included in the public repo — only the pre-trained model ships.

The training data covers multiple bank CSV formats to ensure the model handles different description styles (Chase's `DEBIT CARD PURCHASE` vs Capital One's clean merchant names vs PayPal's `Payment to @handle` format).
