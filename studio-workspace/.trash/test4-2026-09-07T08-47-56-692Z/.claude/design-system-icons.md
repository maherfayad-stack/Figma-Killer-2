# @alm-design/design-system — icons

Generated from the installed package on every chat turn. Do not hand-edit.

**Never hand-draw an SVG path.** Every icon below already exists. A
hand-written `<svg>` is wrong even when it looks close: it will not match
the set's stroke weight, grid, or optical sizing, and it does not inherit
`currentColor` the way these do.

## Icon components (10) — import by name

```jsx
import { CheckboxCheckedIcon, CheckboxSquareIcon, CheckmarkIcon, ChevronDownIcon } from '@alm-design/design-system'
```

They take `className` and inherit colour from `currentColor`, so size and
colour them from the parent rule rather than with props.

`CheckboxCheckedIcon` · `CheckboxSquareIcon` · `CheckmarkIcon` · `ChevronDownIcon` · `ChevronLeftIcon` · `ChevronRightIcon` · `ChevronUpIcon` · `PlaceholderIcon` · `RadioButtonIcon` · `RadioButtonSelectedIcon`

## src/icons/airline-logos (22 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/airline-logos/6E.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

6E, EK, EY, F3, FZ, G9, GF, J9, KL, KU, LH, MS, NP, OV, QR, RJ, RX, SM, SV, TK, WY, XY

## src/icons/footer (3 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/footer/google-play.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

google-play, huawei-appgallery, world-travel-awards

## src/icons/line-icons (343 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/line-icons/24h.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

24h, 3dTour, 48h, accessibleLifts, activitiesBalloon, adult, aerobics, ai, airplaneTilt, arcade, archery, arrowDown, arrowElbowDownLeft, arrowElbowDownLeft-1, arrowElbowDownRight, arrowElbowUpLeft, arrowLeft, arrowRight, arrowUp, arrowsClockwise, arrowsDownUp, arrowsLeftRight, arrowsOut, arrowsReturn, atm, babySitting, badminton, baggageDelay, bakery, balcony, ballroom, bank, basketball, bath, bathrobe, bbq, beachVolleyball, bed, bedLinen, beerBottle, bellboy, bidet, bike, billiards, boat, books, bottle, bowling, briefcase, buffet, bus, cabinBaggage, cabinClass, cafe, calendar, calendarDelay, calendarEnd, calendarFilled, calendarReturn, calendarStart, camera, cancellationAvailable, cancellationNotAvailable, canoeing, carRental, carpet, cash, casinoChip, chain, chalet, chaletFilled, chat, check, checkCircle, checkboxChecked, checkboxSquare, checkinBaggage, checkmark, chevronDown, chevronLeft, chevronRight, chevronUp, child, childrensActivities, childrensBook, chocolate, cloakroom, clothesRack, coffee, coffeeMachine, coffin, coin, compass, compassFilled, concierge, conference, cookie, cookingPot, couch, couple, creditCard, crib, currency, currencyCircleDollar, currencyDollarSimple, desk, diningArea, discount, discountFilled, dishwasher, district, doctorOnCall, door, dressingTable, dumbBell, envelope, extraBaggage, eye, eyeSlash, faceMask, family, familyFriendy, fan, fire, fireExtinguisher, firstAidKit, fish, flightDelayed, flourist, footballPitch, freezer, friends, frontDesk, gameController, garden, garden-1, gift, giftCard, globe, glove, golf, grabRailsToilet, grassLawn, hairdryer, hamburger, handSanitizer, hardwooFloors, headset, heart, heating, homeProjector, horseriding, hourglass, housekeeping, iceMachine, iceSkating, indoorMajlis, indoorPool, infant, infinityPool, infoCircle, installments, internationalChannels, iron, jacuzzi, jetski, kaaba, karaoke, kettle, kitchen, kitchenette, kitchenware, knifeAndFork, laptop, laundry, leaf, leftRight, legroom, lift, lightning, limousine, line, lockCheck, lockSimple, lotus, lounge, maginfyingGlass, mandiBarrel, map, massage, medal, mic, microwave, minigolf, minusCircle, mirror, mobile, mobileBrowser, monitorPlay, multiLingualStaff, navigationArrow, nightClub, noCoffee, noMiniBar, noPets, noSmoking, notRefundable, notifications, offlinePayment, orientationDepartureStateArrival, orientationDepartureStateOutbound, orientationReturnStateArrival, orientationReturnStateOutbound, outdoorMajlis, outdoorPool, oven, parasol, parking, patio, paw, payLater, percentSimple, personalItemFilled, personalItemLine, petsNotAllowed, pharmacy, phone, phoneDisconnect, photocopier, picnic, pin, pinStar, pizza, placeholder, planeFill, planeLine, play, playground, plusCircle, pool, poolBar, poolSafetyRails, powerPlugCharging, prayerRoom, printer, radioButton, radioButtonSelected, refrigerator, refund, rewardCard, roomService, roomSize, sailing, saltWaterPool, sauna, scissors, scuba, seatConfiguration, seatCover, seatWidth, securityCamera, services, share, shavingMirror, shieldCheck, shieldSimple, shoppingTrolley, shower, shuttle, shuttleToAirport, ski, slippers, smiley, smileySad, smoking, sms, snorkeling, snowflake, soap, sofaBed, solarium, solo, speakerMute, speakers, squash, star, starCircle, stethoscope, store, stovetop, sunHorizon, surfing, tableTennis, target, taxiService, tennis, tent, thermometer, thumbsDown, thumbsUp, ticket, tileFloor, timeEvening, timeMidday, timeMorning, timeNight, timer, toaster, toiletPaper, toiletries, towels, train, trampoline, translationServices, tumbleDryer, turkishBath, tv, typeLine, user, userCircle, userCircleFilled, usersThree, usersTwo, valetParking, vault, vendingMachine, visa, volleyball, wallet, wardrobe, warningCircle, waterpark, watersports, weddingServices, whatsapp, wheelchair, wifi, wifiSlash, wine, x, xCircle, xCircleFill, yoga

## src/icons/logo (8 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/logo/Type=AppLogo, Variant=Colour, LA=EN.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

Type=AppLogo, Variant=Colour, LA=EN, Type=AppLogo, Variant=White, LA=NA, Type=Logomark, Variant=Colour, LA=EN, Type=Logomark, Variant=White, LA=EN, Type=Wordmark, Variant=Colour, LA=AR, Type=Wordmark, Variant=Colour, LA=EN, Type=Wordmark, Variant=White, LA=AR, Type=Wordmark, Variant=White, LA=EN

## src/icons/product-icons (4 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/product-icons/productActivities.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

productActivities, productChalets, productFlights, productHotel

## src/icons/visual-icons (116 SVGs)

Import with Vite's `?raw` suffix and inline the markup. This is the only
form that renders on the canvas, and it is the one that inherits
`currentColor` — size and colour it from the parent rule.

```jsx
import iconSvg from '@alm-design/design-system/src/icons/visual-icons/addPoints.svg?raw'
// …then render it: <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />
```

Do NOT drop the `?raw` and render `<img src={…}>`: a packaged asset URL
does not resolve in Studio, and the icon comes out as an empty
"No image selected" box.

addPoints, addTraveller, addonActivities, addonAirportTransfer, addonBaggageProtection, addonBreakfast, addonCancellationFreedom, addonEsim, addonFlightCancellation, addonFlightsDiscount, addonHassleFree, addonHotelsCfar, addonInsurance, addonMeetAndGreet, addonSmartCheckIn, addonSmartDelay, addonTripInsurance, addonView, addonViewAndBreakfast, bookingApp, bookings, cabinCalss, callAdviserExtraBaggage, callCenter, discounts, email, errorActivities, errorApi, errorBranches, errorChalets, errorChat, errorConnection, errorCreditCard, errorEmail, errorFirstClass, errorFlight, errorFlightsTicket, errorHotels, errorNoBookings, errorNoFlight, errorNotifications, errorOffers, errorReward, errorSandClock, errorTransaction, favourites, feedback, forgotPassword, giftCard, globe, iconAttractions, iconBusTours, iconCinema, iconEvents, iconFunAndCulture, iconOutdoor, iconRelaxation, iconSpa, iconSport, iconTickets, iconTours, iconWaterSports, installments, kaaba, loyalty, magnifuingGlass, newPrice, price, serviceCarRental, serviceCargo, serviceConciergeServices, serviceConferenceServices, serviceCruisePackages, serviceDomesticActvities, serviceIntActivities, serviceIntDriversLicense, serviceLanguagePackages, serviceLounges, serviceOverflow, servicePackages, servicePrivateJet, serviceSportsPackages, serviceSummerPackages, serviceTrainTickets, serviceTransfers, serviceTravelBundles, serviceTriptique, serviceVipMeetAndGreet, serviceVisa, sms, stars1Star, stars2Stars, stars3Stars, stars4Stars, stars5Stars, talkToAdvisor, typeBudgetFriendly, typeCabinBaggage, typeCheckedBaggage, typeDestinations, typeExploreAttractions, typeFamily, typeFlightSearch, typeFlightTickets, typeFlightsApp, typeHoneymoonStay, typeLuxuryFamilyStay, typeLuxuryStay, typeShopping, typeTopRated, typeValueForMoney, user, vaccination, wallet, whatsApp, youngTravelers
