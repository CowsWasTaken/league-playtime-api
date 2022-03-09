import axios from "axios";
import express from 'express';
import cors from 'cors'
import {credentials} from "./config/credentials";
import {PlatformHostValue} from "./constants/PlatformHostValue";
import {RegionalHostValue} from "./constants/RegionalHostValue";
import {SummonerDTO} from "./models/DTOs/SummonerDTO";
import {MatchQueryParameter, objectToQueryString} from "./models/MatchQueryParameter";
import {DataStoreService} from "./services/DataStoreService";
import {Mapper} from "./models/Mapper";
import {ApiConfig} from "./config/api_config";
import {QUERY_PARAMS} from "./config/QUERY_PARAMS";
import {MatchEntity} from "./models/Entities/MatchEntity";


const app = express();

app.use(cors())

const protocol = 'https'

const api_key = credentials.apiKey

const api_query = `api_key=${api_key}`

const dataService = new DataStoreService()


async function getPlayerPUUID(platformHost: PlatformHostValue, summonerName: string): Promise<SummonerDTO> {
    return axios.get(`${createBaseUrl(platformHost)}/lol/summoner/v4/summoners/by-name/${summonerName}?${api_query}`)
        .then(response => {
            console.log(`Fetched PUUID: ${response.data.puuid}`)
            return response.data as SummonerDTO
        }).catch(err => err);
}

function createBaseUrl(hostValue: PlatformHostValue | RegionalHostValue): string {
    return `${protocol}://${hostValue}`
}


async function getPlayerMatches(regionalHostValue: RegionalHostValue, puuid: string, matchQueryParameter: MatchQueryParameter): Promise<string[]> {
    const queryString = objectToQueryString(matchQueryParameter)
    let playerMatches_API_CALL = `${createBaseUrl(regionalHostValue)}/lol/match/v5/matches/by-puuid/${puuid}/ids?${api_query}`
    if (queryString.length > 0) {
        playerMatches_API_CALL = `${playerMatches_API_CALL}&${queryString}`
    }
    return axios.get(playerMatches_API_CALL)
        .then(response => {
            console.log(`Fetched Player Matches for: ${puuid}`)
            return response.data
        }).catch(err => err);
}


async function getMatch(regionalHostValue: RegionalHostValue, matchId: string): Promise<any> {
    return axios.get(`${createBaseUrl(regionalHostValue)}/lol/match/v5/matches/${matchId}?${api_query}`)
        .then(response => {
            console.log(`Fetched Match: ${matchId} `)
            return response.data
        }).catch(err => {
            const headers = err.response.headers
            const retryAfter: number = +headers['retry-after']
            const httpError: LeagueHttpError = {description: 'Too Many Requests', status: 429, retryAfter}
            return Promise.reject(httpError)
        });
}

app.get('/matches/:summonername/execute', async (req, res) => {
    // const body = req.body as MatchQueryParameter
    const summonerDTO = await getPlayerPUUID(PlatformHostValue.EUW1, req.params.summonername)
    await dataService.saveSummoner(summonerDTO)

    res.json('Matches get fetched from League Api, this can take up to 10 min')

    await saveAllMatchesForPlayer(summonerDTO)

})

app.get('/matches/:summonername', async (req, res) => {
    // const body = req.body as MatchQueryParameter
    const summonerDTO = await getPlayerPUUID(PlatformHostValue.EUW1, req.params.summonername)
    const list: MatchEntity[] = await dataService.getMatchesForSummoner(summonerDTO.puuid);
    let playtime = 0; // in seconds
    for (let i = 0; i < list.length; i++) {
        const game = list[i]
        /*
        Prior to patch 11.20, this field returns the game length in milliseconds calculated from gameEndTimestamp - gameStartTimestamp. Post patch 11.20, this field returns the max timePlayed of any participant in the game in seconds, which makes the behavior of this field consistent with that of match-v4. The best way to handling the change in this field is to treat the value as milliseconds if the gameEndTimestamp field isn't in the response and to treat the value as seconds if gameEndTimestamp is in the response.
         */
        if (!game.gameEndTimestamp) {
            playtime += (game.gameDuration / 1000)
        } else {
            playtime = playtime + list[i].gameDuration
        }
    }

    res.json(`Total playtime is ${(playtime / 3600).toFixed(2)} Stunden`)
})

app.get('/matches/:summonername/aram', async (req, res) => {
    // const body = req.body as MatchQueryParameter
    const summonerDTO = await getPlayerPUUID(PlatformHostValue.EUW1, req.params.summonername)
    const list: MatchEntity[] = await dataService.getMatchesForSummoner(summonerDTO.puuid);
    let playtime = 0; // in seconds
    for (let i = 0; i < list.length; i++) {
        const game = list[i]
        if (game.gameMode === 'ARAM') {
            /*
            Prior to patch 11.20, this field returns the game length in milliseconds calculated from gameEndTimestamp - gameStartTimestamp. Post patch 11.20, this field returns the max timePlayed of any participant in the game in seconds, which makes the behavior of this field consistent with that of match-v4. The best way to handling the change in this field is to treat the value as milliseconds if the gameEndTimestamp field isn't in the response and to treat the value as seconds if gameEndTimestamp is in the response.
             */
            if (!game.gameEndTimestamp) {
                playtime += (game.gameDuration / 1000)
            } else {
                playtime = playtime + list[i].gameDuration
            }
        }
    }

    res.json(`Total playtime is ${(playtime / 3600).toFixed(2)} Stunden`)
})

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));


async function saveAllMatchesForPlayer(summonerDTO: SummonerDTO) {
    let isFetchedMatchesGreaterMaxCount = true

    for (let i = 0; isFetchedMatchesGreaterMaxCount; i++) {
        const start = i * QUERY_PARAMS.maxCount
        const body: MatchQueryParameter = {count: QUERY_PARAMS.maxCount, start}
        const matchIds: string[] = await getPlayerMatches(RegionalHostValue.EUROPE, summonerDTO.puuid, body)
        if (QUERY_PARAMS.maxCount > matchIds.length) {
            isFetchedMatchesGreaterMaxCount = false
            console.log(`${start + matchIds.length} total matches fetched`)
        }
        await saveMatchesForList(summonerDTO.puuid, matchIds)
    }
    console.log(`All Matches for ${summonerDTO.name} has been fetched`)
}

async function saveMatchesForList(puuid: string, matchIds: string[]) {
    let arr: string[] = [] // list with matchIds witch have been resolved and saved
    let rejected: string[] = []

    for (let i = 0; i < matchIds.length; i++) {
        let matchId = matchIds[i]
        let matchDTO = undefined;
        await saveMatch(puuid, matchId)
            .then(() => arr.push(matchId))
            .catch((err: LeagueHttpError) => {
                if (err.status === 429) {
                    console.log(`429 Too Many Requests, Match ${matchId}`)
                    rejected.push(matchId)
                } else {
                    console.log(`Match ${matchId} cannot be resolved`)
                    console.log(err)
                }
            });
    }
    // await Promise.all(arr) is useless at this point because all saveMatch functions are awaited
    if (rejected.length > 0) {
        console.log(`Timeout for ${ApiConfig.timeoutTime / 1000} seconds`)
        console.log(rejected)
        await delay(ApiConfig.timeoutTime)
        await saveMatchesForList(puuid, rejected)
    }


    //TODO implement if the api call is rejected, retry after specific time
}

async function saveMatch(puuid: string, matchId: string): Promise<any | LeagueHttpError> {
    let matchDTO = undefined;

    matchDTO = await getMatch(RegionalHostValue.EUROPE, matchId).catch((err: LeagueHttpError) => {
        if (err.status == 429)
            return Promise.reject(err)
    })


    const matchEntity = Mapper.matchDTOToEntity(matchDTO)
    return dataService.saveMatch(puuid, matchEntity);
}


app.get('/:summonername', async (req, res) => {
    const summonerDTO = await getPlayerPUUID(PlatformHostValue.EUW1, req.params.summonername)
    await dataService.saveSummoner(Mapper.summonerToEntity(summonerDTO))
    res.json(summonerDTO)
})

app.get('/:summonername/matches/info', async (req, res) => {
    const summonerDTO = await getPlayerPUUID(PlatformHostValue.EUW1, req.params.summonername)
    res.json(summonerDTO)
})


app.listen(4000, function () {
    console.log("Server started on localhost 4000")
}) // localhost:4000

function handleErrors() {

}

function sleeper(ms: number) {
    return function (x: unknown) {
        return new Promise(resolve => setTimeout(() => resolve(x), ms));
    };
}

export interface LeagueHttpError {
    status: number,
    description: string,
    retryAfter?: number

}