"""Общие хелперы для разбора транзакций Solana (jsonParsed)."""
import base64
import struct

ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + ALPH.index(c)
    full = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + full


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPH[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


WSOL = "So11111111111111111111111111111111111111112"
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"

JITO_TIPS = {
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
}

KNOWN = {
    PUMP: "PUMP.FUN",
    PUMP_AMM: "PUMPSWAP_AMM",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ": "PUMP_FEES",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "JUPITER_V6",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "RAYDIUM_AMM_V4",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "RAYDIUM_CPMM",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "RAYDIUM_CLMM",
    "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj": "RAYDIUM_LAUNCHLAB",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "METEORA_DLMM",
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "METEORA_POOLS",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "METEORA_DAMM_V2",
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN": "METEORA_DBC",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "ORCA_WHIRLPOOL",
    "SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe": "SOLFI",
    "ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY": "ZEROFI",
    "obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y": "OBRIC_V2",
    "TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH": "TESSERA_V",
    "HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt": "HUMIDIFI",
    "goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j": "GOONFI",
    "ComputeBudget111111111111111111111111111111": "COMPUTE_BUDGET",
    "11111111111111111111111111111111": "SYSTEM",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "SPL_TOKEN",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "TOKEN_2022",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "ATA",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr": "MEMO",
    "AddressLookupTab1e1111111111111111111111111": "ALT",
    WSOL: "WSOL",
    "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV": "PUMP_GLOBAL_FEE_CFG",
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1": "PUMP_EVENT_AUTH",
}
for t in JITO_TIPS:
    KNOWN[t] = "JITO_TIP"


def compute_budget(ixs):
    """Достаёт CU limit и CU price (micro-lamports) из инструкций ComputeBudget."""
    out = {}
    for ix in ixs:
        if ix.get("programId") != "ComputeBudget111111111111111111111111111111":
            continue
        d = b58decode(ix.get("data", ""))
        if not d:
            continue
        if d[0] == 2 and len(d) >= 5:
            out["cu_limit"] = struct.unpack_from("<I", d, 1)[0]
        elif d[0] == 3 and len(d) >= 9:
            out["cu_price"] = struct.unpack_from("<Q", d, 1)[0]
        elif d[0] == 1:
            out["heap"] = struct.unpack_from("<I", d, 1)[0]
        elif d[0] == 4:
            out["loaded_acc_limit"] = struct.unpack_from("<I", d, 1)[0]
    return out


def program_data_events(logs):
    """Все base64 'Program data:' payload'ы (Anchor events)."""
    out = []
    for line in logs or []:
        if line.startswith("Program data: "):
            try:
                out.append(base64.b64decode(line[len("Program data: "):]))
            except Exception:
                pass
    return out
