import { parseAbi, toEventSelector } from "viem";

export const FactoryAbi = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed oldRecipient, address indexed newRecipient)",
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

export const DistributorFactoryAbi = parseAbi([
  "event DistributorCreated(address indexed token, address distributor)",
]);

export const DistributorAbi = parseAbi([
  "event Harvested(address indexed caller, uint256 quoteAmount, uint256 coinAmount)",
  "event EpochPublished(uint256 indexed epochId, bytes32 root, uint256 quoteTotal, uint256 coinTotal, uint64 expiresAt, string uri)",
  "event Claimed(uint256 indexed epochId, address indexed account, uint256 quoteAmount, uint256 coinAmount)",
  "function unallocatedQuote() view returns (uint256)",
  "function epochCount() view returns (uint256)",
  "function getEpoch(uint256 epochId) view returns ((bytes32 root, uint256 quoteTotal, uint256 coinTotal, uint64 expiresAt, string uri))",
  "function hasClaimed(uint256 epochId, address account) view returns (bool)",
]);

export const CurveAbi = parseAbi([
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "function getReserves() view returns (uint256, uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function sellableTokens() view returns (uint256)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address to) payable returns (uint256)",
]);

export const Erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export const RouterAbi = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
]);

export const QuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const Multicall3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const ev = (abi, name) => abi.find((x) => x.type === "event" && x.name === name);

export const EVENTS = {
  TokenLaunched: ev(FactoryAbi, "TokenLaunched"),
  CreatorFeeRecipientUpdated: ev(FactoryAbi, "CreatorFeeRecipientUpdated"),
  DistributorCreated: ev(DistributorFactoryAbi, "DistributorCreated"),
  Harvested: ev(DistributorAbi, "Harvested"),
  EpochPublished: ev(DistributorAbi, "EpochPublished"),
  Claimed: ev(DistributorAbi, "Claimed"),
  CurveBuy: ev(CurveAbi, "CurveBuy"),
  Transfer: ev(Erc20Abi, "Transfer"),
};

export const TOPICS = Object.fromEntries(
  Object.entries(EVENTS).map(([k, e]) => [k, toEventSelector(e)]),
);
