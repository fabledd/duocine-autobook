# Flux de réservation Pathé — validé le 12/10/2026

Simulation complète réalisée sur `s.pathe.fr` avec le compte Cinépass Gold Duo.
Réservation de test créée : **WPQSTNJ** (NAZA, Pathé Les Fauvettes, lun. 12/10 19:30, place A3 PMR, 0,00 €).

## Vue d'ensemble

```
s.pathe.fr/fr/{SESSION_ID}/booking?pos=c2VhdGluZw==&token={TOKEN}
        │
        ▼
 [1] Sélection des places     pos=seating (base64: c2VhdGluZw==)
        │  td[data-status="available"]  →  (popup PMR: "J'ai compris")  →  "Valider"
        ▼
 [2] Sélection des tarifs     pos=pricing (base64: cHJpY2luZw==)
        │  li:has-text("Cinépass de Redwan") button.more-btn  →  "Valider ma commande"
        ▼
 [3] Confirmation             /fr/{SESSION_ID}/confirmation?token={TOKEN}
        │  N° de réservation + e-billet (email) + QR
        ▼
 [4] E-billet / QR
           GET /api/order/fr-FR/{CINEMA_NUM}/{TOKEN}/complementary_ticket/img
```

**Délai critique : 15 minutes** entre la première place sélectionnée et la validation.
Au-delà : popin « Votre session a expiré » → bouton « Recommencer » (nouveau token).

---

## Étape 1 — Sélection des places

URL : `https://s.pathe.fr/fr/{ID}/booking?pos=c2VhdGluZw%3D%3D&token={TOKEN}`

### DOM des sièges

```html
<td data-number="A3"
    data-type="Emplacement PMR"
    data-seattypecode="DIS"
    data-status="available"
    id="seatIdA3119"
    class="seat">
```

| Attribut | Valeurs utiles |
|---|---|
| `data-status` | `available` \| `selected` \| `occupied` (ou absent si réservé) |
| `data-seattypecode` | `DIS` = PMR / accessible ; autre = standard |
| `data-number` | ex. `A3`, `A10` |
| `id` | `seatId{NUMBER}{ROW_ID}` — unique, utilisable tel quel |

### Sélection d'une place

1. **Préférer une place non-PMR** : `td[data-status="available"]:not([data-seattypecode="DIS"])`
2. Sinon PMR : `td[data-status="available"]` → **popin obligatoire**
3. Cliquer la place → statut devient `selected`

### Popin PMR (si `data-seattypecode="DIS"`)

```
Titre : Emplacement PMR
Texte : Ce emplacement sans fauteuil est strictement réservé aux personnes
        à mobilité réduite. Ceci est un espace dédié à l'accueil d'une
        personne avec son fauteuil roulant.
Boutons : "Choisir un autre siège" | "J'ai compris"
```

→ Cliquer **« J'ai compris »** pour confirmer.

### Valider

Bouton `Valider` (mobile : `button.btn.f-width.rounded.hide-on-tablet.hide-on-desktop`).
Après clic, URL devient `pos=cHJpY2luZw%3D%3D` (pricing).

Indicateurs utiles :
- `.seat-dropdown-trigger` → `"1 place réservée A3"`
- Compteur : `"1 place libre"` / `"N places libres"`

---

## Étape 2 — Tarifs

URL : `.../booking?pos=cHJpY2luZw%3D%3D&token={TOKEN}`

### Liste des tarifs (ul.price-list > li)

| Libellé | Prix | Usage |
|---|---|---|
| **Cinépass de Redwan** (Carte n°EED6 KBBA ACAA) | 0,00 € | Titulaire du Duo — max 2 places |
| Mon Accompagnant CinéPass | 0,00 € +9,00 € compléments | 2e place Duo |
| Mon Accompagnant -14 ans | 0,00 € +5,00 € compléments | Enfant du titulaire |
| Plein tarif | 15,40 € | — |
| Etudiant Scolaire | 9,90 € | — |
| Moins de 14 ans | 7,00 € | — |

Chaque tarif a un stepper :

```html
<div class="number-wrapper">
  <button class="btn round less-btn">−</button>
  <input type="number" min="0" id="form-number">  <!-- id dupliqué ! -->
  <button class="btn round more-btn">+</button>
</div>
```

**Attention** : `id="form-number"` est dupliqué sur tous les steppers → utiliser le scope `li`.

### Action

1. `li:has-text("Cinépass de Redwan") button.more-btn` → quantité = 1
2. Vérifier `.confirmation-btns-container.is-visible` et le texte `Valider ma commande`
3. Cliquer **`Valider ma commande`** (texte exact)

Résumé visible : `Mon tarif 1x CinéPass Gold Duo 0.00€ Total à régler 0.00€`

---

## Étape 3 — Confirmation

URL : `https://s.pathe.fr/fr/{ID}/confirmation?token={TOKEN}&requestor=&email=`

### Contenu clé

```
Commande validée
Un e-mail de confirmation avec votre e-billet a été envoyé à {email}.
N° de réservation : WPQSTNJ
```

- Regex : `/N° de réservation\s*:\s*([A-Z0-9]+)/`
- Détails séance dans `.ticket` (heure, salle, place, tarif, total)
- Bouton `Télécharger mon e-billet` (handler JS, pas d'href)
- L'e-billet + QR partent **par email** automatiquement

### E-billet / QR

```
GET https://s.pathe.fr/api/order/fr-FR/{CINEMA_NUM}/{TOKEN}/complementary_ticket/img
```

- `{CINEMA_NUM}` : ex. `3143` pour Les Fauvettes (extrait de l'URL `/fr/V3143S78583/`)
- `{TOKEN}` : le token de session de réservation
- **Nécessite les cookies de session** (403 sans)
- L'image est le QR code de l'e-billet

---

## Erreurs et pièges

| Problème | Solution |
|---|---|
| Session expirée (15 min) | Cliquer « Recommencer », nouveau token, tout reprendre |
| `id="form-number"` dupliqué | Scoper par `li` du tarif |
| Place PMR sans popup | Ne jamais forcer : toujours passer par « J'ai compris » |
| Image e-billet 403 | Envoyer les cookies Playwright / storageState |
| Double-clic sur Valider | Le 2e clic peut corrompre — attendre la navigation |
| Choix multiple places | 2e place : `Mon Accompagnant CinéPass` via son propre `more-btn` |

---

## Sélecteurs Playwright recommandés

```js
// 1. Place libre (non-PMR en priorité)
const seat = page.locator('td[data-status="available"]:not([data-seattypecode="DIS"])').first()
  ?? page.locator('td[data-status="available"]').first();
await seat.click();

// 2. Popup PMR éventuel
const pmrOk = page.getByRole('button', { name: "J'ai compris", exact: true });
if (await pmrOk.count()) await pmrOk.click();

// 3. Valider les places
await page.locator('button', { hasText: 'Valider' }).click();

// 4. Quantité Cinépass (attendre la page pricing)
await page.locator('li').filter({ hasText: 'Cinépass de Redwan' }).locator('button.more-btn').click();

// 5. Valider la commande (RAPIDE — 15 min max)
await page.getByText('Valider ma commande', { exact: true }).click();

// 6. Lire la référence
await page.waitForURL(/confirmation/);
const ref = await page.locator('text=/N° de réservation/').textContent();
```

---

## Compte de test utilisé

- Email : `haredwan@icloud.com`
- Carte Cinépass : `EED6 KBBA ACAA` (CinéPass Gold Duo)
- Cinéma test : Pathé Les Fauvettes (58 av. des Gobelins, 75013 Paris)
- Séance test : NAZA, lundi 12 octobre 2026 19:30 VOST, Salle 1
- Résultat : **WPQSTNJ**, place A3, total 0,00 €
