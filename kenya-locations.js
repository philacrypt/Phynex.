/**
 * KENYA_COUNTIES
 * All 47 counties of Kenya, each mapped to its sub-counties.
 * Sub-counties follow the official IEBC constituency boundaries, which is the
 * standard breakdown used for delivery/address forms in Kenya (290 total).
 * Keys are county names; values are arrays of sub-county names.
 */
(function (global) {
  "use strict";

  var KENYA_COUNTIES = {
    "Baringo": ["Baringo Central", "Baringo North", "Baringo South", "Eldama Ravine", "Mogotio", "Tiaty"],
    "Bomet": ["Bomet Central", "Bomet East", "Chepalungu", "Konoin", "Sotik"],
    "Bungoma": ["Bumula", "Kabuchai", "Kanduyi", "Kimilili", "Mt. Elgon", "Sirisia", "Tongaren", "Webuye East", "Webuye West"],
    "Busia": ["Budalangi", "Butula", "Funyula", "Matayos", "Nambale", "Teso North", "Teso South"],
    "Elgeyo-Marakwet": ["Keiyo North", "Keiyo South", "Marakwet East", "Marakwet West"],
    "Embu": ["Manyatta", "Mbeere North", "Mbeere South", "Runyenjes"],
    "Garissa": ["Balambala", "Dadaab", "Fafi", "Garissa Township", "Ijara", "Lagdera"],
    "Homa Bay": ["Homa Bay Town", "Kabondo Kasipul", "Karachuonyo", "Kasipul", "Ndhiwa", "Rangwe", "Suba North", "Suba South"],
    "Isiolo": ["Isiolo North", "Isiolo South"],
    "Kajiado": ["Kajiado Central", "Kajiado East", "Kajiado North", "Kajiado South", "Kajiado West"],
    "Kakamega": ["Butere", "Ikolomani", "Khwisero", "Likuyani", "Lugari", "Lurambi", "Malava", "Matungu", "Mumias East", "Mumias West", "Navakholo", "Shinyalu"],
    "Kericho": ["Ainamoi", "Belgut", "Bureti", "Kipkelion East", "Kipkelion West", "Soin/Sigowet"],
    "Kiambu": ["Gatundu North", "Gatundu South", "Githunguri", "Juja", "Kabete", "Kiambaa", "Kiambu", "Kikuyu", "Lari", "Limuru", "Ruiru", "Thika Town"],
    "Kilifi": ["Ganze", "Kaloleni", "Kilifi North", "Kilifi South", "Magarini", "Malindi", "Rabai"],
    "Kirinyaga": ["Gichugu", "Kirinyaga Central", "Mwea", "Ndia"],
    "Kisii": ["Bobasi", "Bomachoge Borabu", "Bomachoge Chache", "Bonchari", "Kitutu Chache North", "Kitutu Chache South", "Nyaribari Chache", "Nyaribari Masaba", "South Mugirango"],
    "Kisumu": ["Kisumu Central", "Kisumu East", "Kisumu West", "Muhoroni", "Nyakach", "Nyando", "Seme"],
    "Kitui": ["Kitui Central", "Kitui East", "Kitui Rural", "Kitui South", "Kitui West", "Mwingi Central", "Mwingi North", "Mwingi West"],
    "Kwale": ["Kinango", "Lunga Lunga", "Matuga", "Msambweni"],
    "Laikipia": ["Laikipia East", "Laikipia North", "Laikipia West"],
    "Lamu": ["Lamu East", "Lamu West"],
    "Machakos": ["Kangundo", "Kathiani", "Machakos Town", "Masinga", "Matungulu", "Mavoko", "Mwala", "Yatta"],
    "Makueni": ["Kaiti", "Kibwezi East", "Kibwezi West", "Kilome", "Makueni", "Mbooni"],
    "Mandera": ["Banissa", "Lafey", "Mandera East", "Mandera North", "Mandera South", "Mandera West"],
    "Marsabit": ["Laisamis", "Moyale", "North Horr", "Saku"],
    "Meru": ["Buuri", "Central Imenti", "Igembe Central", "Igembe North", "Igembe South", "North Imenti", "South Imenti", "Tigania East", "Tigania West"],
    "Migori": ["Awendo", "Kuria East", "Kuria West", "Nyatike", "Rongo", "Suna East", "Suna West", "Uriri"],
    "Mombasa": ["Changamwe", "Jomvu", "Kisauni", "Likoni", "Mvita", "Nyali"],
    "Murang'a": ["Gatanga", "Kandara", "Kangema", "Kigumo", "Kiharu", "Maragwa", "Mathioya"],
    "Nairobi": ["Dagoretti North", "Dagoretti South", "Embakasi Central", "Embakasi East", "Embakasi North", "Embakasi South", "Embakasi West", "Kamukunji", "Kasarani", "Kibra", "Lang'ata", "Makadara", "Mathare", "Roysambu", "Ruaraka", "Starehe", "Westlands"],
    "Nakuru": ["Bahati", "Gilgil", "Kuresoi North", "Kuresoi South", "Molo", "Naivasha", "Nakuru Town East", "Nakuru Town West", "Njoro", "Rongai", "Subukia"],
    "Nandi": ["Aldai", "Chesumei", "Emgwen", "Mosop", "Nandi Hills", "Tinderet"],
    "Narok": ["Emurua Dikirr", "Kilgoris", "Narok East", "Narok North", "Narok South", "Narok West"],
    "Nyamira": ["Borabu", "Kitutu Masaba", "North Mugirango", "West Mugirango"],
    "Nyandarua": ["Kinangop", "Kipipiri", "Ndaragwa", "Ol Jorok", "Ol Kalou"],
    "Nyeri": ["Kieni", "Mathira", "Mukurweini", "Nyeri Town", "Othaya", "Tetu"],
    "Samburu": ["Samburu East", "Samburu North", "Samburu West"],
    "Siaya": ["Alego Usonga", "Bondo", "Gem", "Rarieda", "Ugenya", "Ugunja"],
    "Taita-Taveta": ["Mwatate", "Taveta", "Voi", "Wundanyi"],
    "Tana River": ["Bura", "Galole", "Garsen"],
    "Tharaka-Nithi": ["Chuka/Igambang'ombe", "Maara", "Tharaka"],
    "Trans Nzoia": ["Cherangany", "Endebess", "Kiminini", "Kwanza", "Saboti"],
    "Turkana": ["Loima", "Turkana Central", "Turkana East", "Turkana North", "Turkana South", "Turkana West"],
    "Uasin Gishu": ["Ainabkoi", "Kapseret", "Kesses", "Moiben", "Soy", "Turbo"],
    "Vihiga": ["Emuhaya", "Hamisi", "Luanda", "Sabatia", "Vihiga"],
    "Wajir": ["Eldas", "Tarbaj", "Wajir East", "Wajir North", "Wajir South", "Wajir West"],
    "West Pokot": ["Kacheliba", "Kapenguria", "Pokot South", "Sigor"]
  };

  global.KENYA_COUNTIES = KENYA_COUNTIES;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = KENYA_COUNTIES;
  }
})(typeof window !== "undefined" ? window : this);
