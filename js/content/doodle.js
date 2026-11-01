// Doodle Dash word bank — easy-to-medium things you can sketch in 80 seconds.
// Each round the drawer picks one of three: an easy word, a medium one and a themed wildcard
// ("us" = couple / long-distance flavoured, "silly" = absurd little scenes).

export const EASY = [
  'cat', 'dog', 'fish', 'bird', 'sun', 'moon', 'star', 'cloud', 'rainbow', 'tree',
  'flower', 'apple', 'banana', 'cherries', 'strawberry', 'pizza', 'cupcake', 'donut', 'ice cream', 'cookie',
  'coffee cup', 'teapot', 'house', 'key', 'clock', 'book', 'glasses', 'hat', 'sock', 'sneaker',
  'umbrella', 'balloon', 'kite', 'guitar', 'drum', 'bell', 'candle', 'lamp', 'chair', 'bed',
  'car', 'bus', 'bicycle', 'sailboat', 'train', 'rocket', 'snowman', 'ghost', 'crown', 'egg',
  'carrot', 'mushroom', 'snail', 'bee', 'butterfly', 'spider', 'frog', 'duck', 'turtle', 'bunny',
  'pig', 'owl', 'whale', 'cactus', 'leaf', 'envelope', 'gift', 'lollipop', 'pencil', 'scissors',
];

export const MEDIUM = [
  'penguin', 'giraffe', 'elephant', 'octopus', 'jellyfish', 'flamingo', 'hedgehog', 'sloth', 'dinosaur', 'dragon',
  'unicorn', 'mermaid', 'pirate ship', 'wizard hat', 'robot', 'alien', 'astronaut', 'volcano', 'waterfall', 'lighthouse',
  'desert island', 'castle', 'bridge', 'tent', 'campfire', 'hammock', 'sandcastle', 'windmill', 'palm tree', 'pineapple',
  'watermelon', 'avocado', 'sushi', 'burger', 'taco', 'hot dog', 'popcorn', 'pancakes', 'birthday cake', 'treasure chest',
  'magnifying glass', 'telescope', 'headphones', 'camera', 'light bulb', 'toothbrush', 'ladder', 'anchor', 'hourglass', 'snow globe',
  'igloo', 'tornado', 'lightning', 'fireworks', 'ferris wheel', 'roller coaster', 'hot air balloon', 'parachute', 'submarine', 'skateboard',
  'scarecrow', 'trophy', 'piano', 'peacock', 'squirrel', 'mountain', 'swing set', 'bonsai tree', 'beehive', 'spider web',
];

// Couple & long-distance flavoured.
export const US = [
  'airport hug', 'video call', 'love letter', 'plane ticket', 'suitcase', 'passport', 'postcard', 'holding hands', 'first date', 'picnic',
  'movie night', 'slow dance', 'candlelit dinner', 'breakfast in bed', 'love lock', 'engagement ring', 'bouquet', 'teddy bear', 'matching mugs', 'pillow fort',
  'road trip', 'map pin', 'globe', 'mailbox', 'wifi signal', 'low battery', 'goodnight text', 'care package', 'couple selfie', 'shooting star',
  'sunset', 'stargazing', 'countdown calendar', 'train station', 'airplane window', 'welcome home sign', 'borrowed hoodie', 'two toothbrushes', 'heart balloon', 'box of chocolates',
  'rose', 'kiss', 'hug', 'cuddle', 'paper airplane', 'tin can phone', 'two moons', 'mixtape', 'wedding cake', 'love song',
];

// Small absurd scenes for silly nights.
export const SILLY = [
  'dancing banana', 'cat in a box', 'cowboy frog', 'pirate parrot', 'dog in sunglasses', 'sock puppet', 'snail race', 'grumpy cloud', 'alien selfie', 'haunted house',
  'zombie', 'vampire', 'superhero', 'ninja', 'burrito', 'chicken nugget', 'rubber duck', 'toilet paper', 'banana peel', 'llama',
  'unicorn on a skateboard', 'dinosaur in a tutu', 'bubble bath', 'spaghetti', 'tooth fairy', 'couch potato', 'night owl', 'drama queen', 'busy bee', 'sea monster',
  'disco ball', 'karaoke', 'bad hair day', 'brain freeze', 'sleepwalker', 'lava lamp', 'jelly beans', 'penguin on vacation', 'cat burglar', 'hot potato',
];

export const ALL_WORDS = [...EASY, ...MEDIUM, ...US, ...SILLY];
